/**
 * Anthropic Messages wire. Provider differences come in through
 * `Capabilities`; thinking blocks travel back to the client as an `Opaque`
 * (thinking text plus signature) and are replayed verbatim to the provider
 * that minted them, which is how modelplug stays stateless.
 *
 * Claude API facts this file relies on (2026):
 *   - Current models take `thinking: {type: "adaptive"}` plus
 *     `output_config.effort`; `budget_tokens` is rejected there. Only older
 *     models (Haiku 4.5, Sonnet 4.5, …) still take `{type: "enabled",
 *     budget_tokens}`, which `Capabilities.reasoning: "budget"` selects.
 *   - `temperature` / `top_p` are rejected on current models; the preset
 *     turns the capability off.
 *   - Thinking blocks must go back unchanged. The API drops blocks the target
 *     model cannot read; stripping them yourself can trigger ordering and
 *     signature errors. So a block minted by this provider is always replayed.
 *   - Forced tool use (`any` / `tool`) is rejected by the newest models; it is
 *     still sent when the client asks, because the older ones accept it.
 */
import { randomBytes } from "node:crypto";
import type {
  AssistantMessage,
  Capabilities,
  ErrorKind,
  Event,
  JsonObject,
  Message,
  Opaque,
  ProviderTarget,
  ReasoningEffort,
  StopReason,
  ToolMessage,
  Turn,
  Usage,
  UserMessage,
  Wire,
  WireError,
  WireRequest,
} from "../ir.ts";
import { decodeSse } from "../sse.ts";
import { clampEffort } from "./effort.ts";
import { retryAfterMsFrom } from "./openai-errors.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
/** Streaming leaves room; the API caps it at the model's own limit when `caps.maxOutputTokens` is unset. */
const DEFAULT_MAX_TOKENS = 64_000;
const MIN_BUDGET = 1024;
/** Budget mode only (older models): thinking tokens per effort level. */
const BUDGETS: Record<ReasoningEffort, number> = { minimal: 0, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };
/** `Opaque.kind` values this wire mints. */
export const OPAQUE_THINKING = "thinking";
export const OPAQUE_REDACTED = "redacted_thinking";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/* ------------------------------------------------------------- encode */

function imageBlock(part: { type: "image"; mediaType: string; data: string } | { type: "image_url"; url: string }): JsonObject {
  return part.type === "image" ? { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } } : { type: "image", source: { type: "url", url: part.url } };
}

function userBlocks(message: UserMessage, caps: Capabilities): JsonObject[] {
  const out: JsonObject[] = [];
  let omitted = 0;
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim().length > 0) out.push({ type: "text", text: part.text });
    } else if (caps.images) out.push(imageBlock(part));
    else omitted += 1;
  }
  if (omitted > 0) out.push({ type: "text", text: `[${omitted} image(s) omitted: this model does not accept images]` });
  return out;
}

function toolResultBlock(message: ToolMessage, caps: Capabilities): JsonObject {
  const texts = message.content.filter(p => p.type === "text").map(p => p.text).filter(t => t.trim().length > 0);
  const images = message.content.filter(p => p.type === "image");
  const block: JsonObject = { type: "tool_result", tool_use_id: message.callId };
  if (images.length > 0 && caps.images) {
    block.content = [...texts.map(text => ({ type: "text", text })), ...images.map(imageBlock)];
  } else {
    const text = [...texts, ...(images.length > 0 ? [`[${images.length} image(s) omitted: this model does not accept images]`] : [])].join("\n");
    if (text.length > 0) block.content = text;
  }
  if (message.isError) block.is_error = true;
  return block;
}

/** A thinking block is replayed only when this provider minted it; anything else is dropped. */
function thinkingBlock(opaque: Opaque | undefined, provider: string): JsonObject | undefined {
  if (!opaque || opaque.provider !== provider) return undefined;
  if (opaque.kind === OPAQUE_REDACTED) return { type: "redacted_thinking", data: opaque.data };
  if (opaque.kind !== OPAQUE_THINKING) return undefined;
  try {
    const parsed: unknown = JSON.parse(opaque.data);
    if (!isRecord(parsed) || typeof parsed.thinking !== "string" || typeof parsed.signature !== "string") return undefined;
    return { type: "thinking", thinking: parsed.thinking, signature: parsed.signature };
  } catch {
    return undefined;
  }
}

function toolInput(args: string): JsonObject {
  if (args.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message: AssistantMessage, provider: string): JsonObject[] {
  const out: JsonObject[] = [];
  for (const part of message.content) {
    if (part.type === "reasoning") {
      const block = thinkingBlock(part.opaque, provider);
      if (block) out.push(block);
    } else if (part.type === "text") {
      if (part.text.trim().length > 0) out.push({ type: "text", text: part.text });
    } else {
      out.push({ type: "tool_use", id: part.id, name: part.name, input: toolInput(part.arguments) });
    }
  }
  return out;
}

/**
 * Tool results lead the next user message, several of them together when
 * calls ran in parallel; consecutive same-role messages are merged so the
 * transcript alternates the way the API wants.
 */
function encodeMessages(messages: Message[], caps: Capabilities, provider: string): Array<{ role: "user" | "assistant"; content: JsonObject[] }> {
  const out: Array<{ role: "user" | "assistant"; content: JsonObject[] }> = [];
  const push = (role: "user" | "assistant", blocks: JsonObject[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "assistant") push("assistant", assistantBlocks(message, provider));
    else if (message.role === "tool") {
      const last = out[out.length - 1];
      // A result must be the first thing in its user message; text that came earlier starts a new one.
      if (last && last.role === "user" && last.content.some(b => b.type !== "tool_result")) out.push({ role: "user", content: [toolResultBlock(message, caps)] });
      else push("user", [toolResultBlock(message, caps)]);
    } else push("user", userBlocks(message, caps));
  }
  return out;
}

function toolChoice(turn: Turn): JsonObject | undefined {
  const choice = turn.toolChoice;
  let out: JsonObject | undefined;
  if (choice === undefined) out = turn.parallelToolCalls === false ? { type: "auto" } : undefined;
  else if (choice === "auto") out = { type: "auto" };
  else if (choice === "none") out = { type: "none" };
  else if (choice === "required") out = { type: "any" };
  else out = { type: "tool", name: choice.name };
  if (out && turn.parallelToolCalls === false && out.type !== "none") out.disable_parallel_tool_use = true;
  return out;
}

export function encodeAnthropicRequest(turn: Turn, caps: Capabilities, target: ProviderTarget, stream: boolean): WireRequest {
  const body: Record<string, unknown> = { model: turn.model, max_tokens: 0 };
  if (turn.system) body.system = turn.system;
  body.messages = encodeMessages(turn.messages, caps, target.name);
  if (caps.tools && turn.tools && turn.tools.length > 0) {
    body.tools = turn.tools.map(t => {
      const tool: JsonObject = { name: t.name, input_schema: t.parameters };
      if (t.description) tool.description = t.description;
      if (t.strict) tool.strict = true;
      // Stream large tool inputs (patches, file contents) as they are generated instead of in one burst.
      if (stream) tool.eager_input_streaming = true;
      return tool;
    });
    const choice = toolChoice(turn);
    if (choice) body.tool_choice = choice;
  }

  const ceiling = caps.maxOutputTokens;
  let maxTokens = turn.sampling?.maxOutputTokens ?? ceiling ?? DEFAULT_MAX_TOKENS;
  if (ceiling !== undefined) maxTokens = Math.min(maxTokens, ceiling);
  if (caps.temperature && turn.sampling?.temperature !== undefined) body.temperature = turn.sampling.temperature;
  if (caps.temperature && turn.sampling?.topP !== undefined) body.top_p = turn.sampling.topP;
  if (turn.sampling?.stop && turn.sampling.stop.length > 0) body.stop_sequences = turn.sampling.stop;

  const effort = turn.reasoning?.effort;
  if (turn.reasoning && caps.reasoning === "effort") {
    body.thinking = { type: "adaptive", display: "summarized" };
    if (effort !== undefined) body.output_config = { effort: clampEffort(effort === "minimal" ? "low" : effort, caps.reasoningLevels) };
  } else if (turn.reasoning && caps.reasoning === "budget" && effort !== "minimal") {
    let budget = Math.max(MIN_BUDGET, turn.reasoning.budgetTokens ?? BUDGETS[effort ?? "medium"]);
    if (ceiling !== undefined) budget = Math.min(budget, ceiling - MIN_BUDGET);
    // A cap below the minimum thinking budget plus answer room cannot support thinking.
    if (budget >= MIN_BUDGET) {
      // The budget must stay below max_tokens; raise the ceiling for the answer when the client asked for less.
      if (maxTokens <= budget) maxTokens = ceiling !== undefined ? Math.min(ceiling, budget + 4096) : budget + 4096;
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
  }
  body.max_tokens = maxTokens;

  if (turn.responseFormat?.type === "json_schema") {
    body.output_config = { ...((body.output_config as JsonObject | undefined) ?? {}), format: { type: "json_schema", schema: turn.responseFormat.schema } };
  }
  body.stream = stream;
  // Cache the longest cacheable prefix: free, and an agent loop extends the prefix every turn.
  body.cache_control = { type: "ephemeral" };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    ...(target.headers ?? {}),
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (target.apiKey) headers["x-api-key"] = target.apiKey;
  return { url: `${target.baseUrl}/v1/messages`, method: "POST", headers, body: JSON.stringify(body) };
}

/* ------------------------------------------------------------- decode */

type Block =
  | { kind: "text" }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; id: string; name: string; json: string; initial?: string }
  | { kind: "other" };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** `input_tokens` excludes cache reads and writes; the IR total includes them. */
export function usageFromAnthropic(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = num(value.input_tokens);
  const output = num(value.output_tokens);
  const cacheRead = num(value.cache_read_input_tokens);
  const cacheWrite = num(value.cache_creation_input_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  const usage: Usage = { inputTokens: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0), outputTokens: output ?? 0 };
  if (cacheRead !== undefined) usage.cachedInputTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

function mergeUsage(base: Usage | undefined, delta: unknown): Usage | undefined {
  if (!isRecord(delta)) return base;
  const input = num(delta.input_tokens);
  const output = num(delta.output_tokens);
  const cacheRead = num(delta.cache_read_input_tokens);
  const cacheWrite = num(delta.cache_creation_input_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return base;
  const out: Usage = { ...(base ?? { inputTokens: 0, outputTokens: 0 }) };
  if (output !== undefined) out.outputTokens = output;
  if ((input !== undefined && input > 0) || (cacheRead !== undefined && cacheRead > 0) || (cacheWrite !== undefined && cacheWrite > 0)) {
    const uncached = input !== undefined && input > 0 ? input : out.inputTokens - (out.cachedInputTokens ?? 0) - (out.cacheWriteTokens ?? 0);
    if (cacheRead !== undefined && cacheRead > 0) out.cachedInputTokens = cacheRead;
    if (cacheWrite !== undefined && cacheWrite > 0) out.cacheWriteTokens = cacheWrite;
    out.inputTokens = uncached + (out.cachedInputTokens ?? 0) + (out.cacheWriteTokens ?? 0);
  }
  return out;
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "content_filter";
    default:
      return "end_turn";
  }
}

export async function* decodeAnthropicStream(response: Response, _caps: Capabilities, target: ProviderTarget): AsyncGenerator<Event> {
  const provider = target.name;
  const blocks = new Map<number, Block>();
  let model: string | undefined;
  let stopReason: string | undefined;
  let usage: Usage | undefined;
  let emitted = false;
  let stopped = false;

  const opaqueFor = (kind: string, data: string): Opaque => {
    const opaque: Opaque = { provider, kind, data };
    if (model) opaque.model = model;
    return opaque;
  };

  try {
    for await (const frame of decodeSse(response.body)) {
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (!isRecord(data)) continue;
      const type = typeof data.type === "string" ? data.type : frame.event;
      switch (type) {
        case "message_start": {
          const message = isRecord(data.message) ? data.message : {};
          if (typeof message.model === "string") model = message.model;
          usage = usageFromAnthropic(message.usage) ?? usage;
          break;
        }
        case "content_block_start": {
          const index = num(data.index) ?? blocks.size;
          const block = isRecord(data.content_block) ? data.content_block : {};
          if (block.type === "text") {
            blocks.set(index, { kind: "text" });
            if (typeof block.text === "string" && block.text.length > 0) {
              emitted = true;
              yield { type: "text_delta", text: block.text };
            }
          } else if (block.type === "thinking") {
            const initial = typeof block.thinking === "string" ? block.thinking : "";
            blocks.set(index, { kind: "thinking", thinking: initial, signature: typeof block.signature === "string" ? block.signature : "" });
            if (initial.length > 0) {
              emitted = true;
              yield { type: "reasoning_delta", text: initial };
            }
          }
          else if (block.type === "redacted_thinking") blocks.set(index, { kind: "redacted", data: typeof block.data === "string" ? block.data : "" });
          else if (block.type === "tool_use") {
            const id = typeof block.id === "string" && block.id ? block.id : `toolu_${randomBytes(8).toString("hex")}`;
            const name = typeof block.name === "string" ? block.name : "";
            const tool: Block = { kind: "tool", id, name, json: "" };
            if (isRecord(block.input) && Object.keys(block.input).length > 0) tool.initial = JSON.stringify(block.input);
            blocks.set(index, tool);
            emitted = true;
            yield { type: "tool_call_start", id, name };
          } else blocks.set(index, { kind: "other" });
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(num(data.index) ?? -1);
          const delta = isRecord(data.delta) ? data.delta : undefined;
          if (!block || !delta) break;
          if (delta.type === "text_delta" && block.kind === "text" && typeof delta.text === "string" && delta.text.length > 0) {
            emitted = true;
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "thinking_delta" && block.kind === "thinking" && typeof delta.thinking === "string") {
            block.thinking += delta.thinking;
            if (delta.thinking.length > 0) {
              emitted = true;
              yield { type: "reasoning_delta", text: delta.thinking };
            }
          } else if (delta.type === "signature_delta" && block.kind === "thinking" && typeof delta.signature === "string") {
            block.signature += delta.signature;
          } else if (delta.type === "input_json_delta" && block.kind === "tool" && typeof delta.partial_json === "string") {
            block.json += delta.partial_json;
            if (delta.partial_json.length > 0) yield { type: "tool_call_delta", id: block.id, argumentsDelta: delta.partial_json };
          }
          break;
        }
        case "content_block_stop": {
          const index = num(data.index) ?? -1;
          const block = blocks.get(index);
          if (!block) break;
          blocks.delete(index);
          if (block.kind === "thinking") {
            emitted = true;
            yield { type: "reasoning_opaque", opaque: opaqueFor(OPAQUE_THINKING, JSON.stringify({ thinking: block.thinking, signature: block.signature })) };
          } else if (block.kind === "redacted") {
            emitted = true;
            yield { type: "reasoning_opaque", opaque: opaqueFor(OPAQUE_REDACTED, block.data) };
          } else if (block.kind === "tool") {
            if (block.json.length === 0) yield { type: "tool_call_delta", id: block.id, argumentsDelta: block.initial ?? "{}" };
            yield { type: "tool_call_end", id: block.id };
          }
          break;
        }
        case "message_delta": {
          const delta = isRecord(data.delta) ? data.delta : {};
          if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
          usage = mergeUsage(usage, data.usage);
          break;
        }
        case "message_stop":
          stopped = true;
          break;
        case "error": {
          yield { type: "error", error: classifyAnthropicError(response.status, response.headers, JSON.stringify(data), provider) };
          return;
        }
        default:
          break;
      }
      if (stopped) break;
    }
  } catch (err) {
    yield { type: "error", error: { kind: "upstream", message: `the stream ended without message_stop: ${err instanceof Error ? err.message : String(err)}`, provider, retryable: !emitted } };
    return;
  }
  if (!stopped) {
    yield { type: "error", error: { kind: "upstream", message: "the stream ended without message_stop", provider, retryable: !emitted } };
    return;
  }
  const done: Event = { type: "done", stopReason: mapStop(stopReason) };
  if (usage) done.usage = usage;
  yield done;
}

/* ----------------------------------------------------------- classify */

/** `{type: "error", error: {type, message}}`, or whatever text the upstream sent. */
export function anthropicErrorMessage(bodyText: string): { message: string; type?: string } {
  const text = bodyText.trim();
  if (text.length === 0) return { message: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      const out: { message: string; type?: string } = { message: typeof error.message === "string" ? error.message : text.slice(0, 300) };
      if (typeof error.type === "string") out.type = error.type;
      return out;
    }
  } catch {
    /* not JSON */
  }
  return { message: text.slice(0, 300) };
}

export function classifyAnthropicError(status: number, headers: Headers, bodyText: string, provider: string, now: number = Date.now()): WireError {
  const { message, type } = anthropicErrorMessage(bodyText);
  const lower = `${message} ${type ?? ""}`.toLowerCase();
  const retryAfterMs = retryAfterMsFrom(headers, now);
  const base = (kind: ErrorKind, retryable: boolean): WireError => {
    const err: WireError = { kind, message: message || `HTTP ${status}`, provider, status, retryable };
    if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
    return err;
  };
  if (status === 401 || status === 403) return base("auth", false);
  if (status === 402 || type === "billing_error") return base("quota", false);
  if (status === 404 || type === "not_found_error") return base("not_found", false);
  if (status === 429) return base("rate_limit", true);
  if (status === 413) return base("context_length", false);
  if (status === 400 || status === 422) {
    if (/prompt is too long|too many tokens|exceeds the (context|maximum)|context window|input length/.test(lower)) return base("context_length", false);
    if (/credit balance|billing|usage limit|spending limit/.test(lower)) return base("quota", false);
    return base("invalid_request", false);
  }
  if (status === 529 || type === "overloaded_error") return base("overloaded", true);
  if (status === 408 || status >= 500) return base("upstream", true);
  if (status >= 200 && status < 300) return base("upstream", false);
  return base("upstream", false);
}

export const anthropicWire: Wire = {
  name: "anthropic",
  encode: encodeAnthropicRequest,
  decode: decodeAnthropicStream,
  classifyError(status, headers, bodyText, target) {
    return classifyAnthropicError(status, headers, bodyText, target.name);
  },
  modelsRequest(target) {
    const headers: Record<string, string> = { accept: "application/json", ...(target.headers ?? {}), "anthropic-version": ANTHROPIC_VERSION };
    if (target.apiKey) headers["x-api-key"] = target.apiKey;
    return { url: `${target.baseUrl}/v1/models`, headers };
  },
  parseModels(body) {
    if (!isRecord(body) || !Array.isArray(body.data)) return [];
    const ids = new Set<string>();
    for (const item of body.data) if (isRecord(item) && typeof item.id === "string" && item.id) ids.add(item.id);
    return [...ids].sort();
  },
};
