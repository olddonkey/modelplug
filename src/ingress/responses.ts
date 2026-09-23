/**
 * The Responses ingress: Codex's protocol in, IR out, and IR events back out
 * as Responses SSE. Handles the classic dialect Codex sends to any
 * `provider/model` name. The Lite dialect (OpenAI model names) never reaches
 * this module: it is relayed by the passthrough.
 */
import { randomBytes } from "node:crypto";
import type {
  AssistantMessage,
  AssistantPart,
  ErrorKind,
  Event,
  ImagePart,
  JsonObject,
  Message,
  Opaque,
  ParsedIngress,
  ReasoningEffort,
  ResponseSink,
  Tool,
  ToolChoice,
  ToolMessage,
  ToolResultPart,
  Turn,
  Usage,
  UserPart,
} from "../ir.ts";
import { encodeSse } from "../sse.ts";

export class IngressError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "IngressError";
    this.status = status;
    this.code = code;
  }
}

/** What the ingress did to the request so `respond` can restore the client's shape. Request-local. */
export interface Lowering {
  /** Freeform (`custom`) tools lowered to one-string-parameter functions. */
  customTools: Set<string>;
  /** Flattened name → original namespace and child name. */
  namespaceAliases: Map<string, { namespace: string; name: string }>;
  /** Bare child name → flattened name, for replayed calls that omit the namespace. */
  bareToAlias: Map<string, string>;
  /** Hosted tools the target cannot run. */
  droppedTools: string[];
  warnings: string[];
}

export interface ParsedResponses extends ParsedIngress {
  lowering: Lowering;
  reasoning?: { effort?: string; summary?: string };
}

const HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "file_search",
  "code_interpreter",
  "image_generation",
  "computer_use_preview",
  "computer",
  "mcp",
  "local_shell",
  "shell",
]);

const DROPPED_ITEM_TYPES = new Set([
  "web_search_call",
  "file_search_call",
  "computer_call",
  "computer_call_output",
  "image_generation_call",
  "code_interpreter_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "local_shell_call",
  "local_shell_call_output",
  "compaction",
]);

const EFFORTS: Record<string, ReasoningEffort> = { none: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/* ------------------------------------------------------------- opaque */

/** Provider-bound bytes travel inside `encrypted_content`, which the client echoes back untouched. */
export function encodeOpaque(opaque: Opaque): string {
  const payload: Record<string, unknown> = { v: 1, p: opaque.provider, k: opaque.kind, d: opaque.data };
  if (opaque.model !== undefined) payload.m = opaque.model;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodeOpaque(text: string): Opaque | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1 || typeof o.p !== "string" || typeof o.k !== "string" || typeof o.d !== "string") return undefined;
    const opaque: Opaque = { provider: o.p, kind: o.k, data: o.d };
    if (typeof o.m === "string") opaque.model = o.m;
    return opaque;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------- parse */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parseResponsesRequest(body: unknown): ParsedResponses {
  if (!isRecord(body)) throw new IngressError(400, "invalid_request", "request body must be a JSON object");
  const modelRef = str(body.model)?.trim();
  if (!modelRef) throw new IngressError(400, "invalid_request", "model is required");
  if (typeof body.previous_response_id === "string") {
    throw new IngressError(400, "unsupported", "previous_response_id is not supported: modelplug keeps no conversation state; send the full transcript with store: false");
  }

  const lowering: Lowering = { customTools: new Set(), namespaceAliases: new Map(), bareToAlias: new Map(), droppedTools: [], warnings: [] };
  const systemParts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.length > 0) systemParts.push(body.instructions);

  const tools = parseTools(body.tools, lowering);
  const toolNames = new Set(tools.map(t => t.name));
  const messages = parseInput(body.input, systemParts, lowering, toolNames);

  const turn: Turn = { model: modelRef, messages };
  if (systemParts.length > 0) turn.system = systemParts.join("\n\n");
  if (tools.length > 0) turn.tools = tools;
  const toolChoice = parseToolChoice(body.tool_choice, lowering, turn);
  if (toolChoice !== undefined) turn.toolChoice = toolChoice;
  if (typeof body.parallel_tool_calls === "boolean") turn.parallelToolCalls = body.parallel_tool_calls;

  const parsed: ParsedResponses = { modelRef, turn, stream: body.stream === true, lowering };
  if (isRecord(body.reasoning)) {
    const effort = str(body.reasoning.effort);
    const summary = str(body.reasoning.summary);
    const reasoning: Turn["reasoning"] = {};
    if (effort && EFFORTS[effort]) reasoning.effort = EFFORTS[effort];
    if (summary) reasoning.summary = summary === "none" ? "none" : "auto";
    if (Object.keys(reasoning).length > 0) turn.reasoning = reasoning;
    const echo: { effort?: string; summary?: string } = {};
    if (effort) echo.effort = effort;
    if (summary) echo.summary = summary;
    parsed.reasoning = echo;
  }
  const sampling: NonNullable<Turn["sampling"]> = {};
  if (typeof body.max_output_tokens === "number") sampling.maxOutputTokens = body.max_output_tokens;
  if (typeof body.temperature === "number") sampling.temperature = body.temperature;
  if (typeof body.top_p === "number") sampling.topP = body.top_p;
  if (Object.keys(sampling).length > 0) turn.sampling = sampling;
  if (isRecord(body.text) && isRecord(body.text.format)) {
    const format = body.text.format;
    if (format.type === "json_schema" && isRecord(format.schema)) {
      turn.responseFormat = { type: "json_schema", name: str(format.name) ?? "response", schema: format.schema as JsonObject, ...(format.strict === true ? { strict: true } : {}) };
    } else if (format.type === "json_object") {
      turn.responseFormat = { type: "json" };
    }
  }
  const metadata: NonNullable<Turn["metadata"]> = {};
  if (typeof body.prompt_cache_key === "string") metadata.conversationId = body.prompt_cache_key;
  if (Object.keys(metadata).length > 0) turn.metadata = metadata;
  return parsed;
}

function parseTools(raw: unknown, lowering: Lowering): Tool[] {
  if (!Array.isArray(raw)) return [];
  const out: Tool[] = [];
  const add = (tool: Tool): void => {
    if (out.some(t => t.name === tool.name)) return;
    out.push(tool);
  };
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const type = str(entry.type);
    if (type === "function") {
      const tool = functionTool(entry);
      if (tool) add(tool);
    } else if (type === "custom") {
      const name = str(entry.name);
      if (!name) continue;
      lowering.customTools.add(name);
      const description = `${str(entry.description) ?? ""}\nFreeform tool: put the entire raw input text in the single string argument "input".`.trim();
      add({ name, description, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } });
    } else if (type === "namespace") {
      const namespace = str(entry.name);
      if (!namespace || !Array.isArray(entry.tools)) continue;
      const nsDescription = str(entry.description);
      for (const child of entry.tools) {
        if (!isRecord(child)) continue;
        const childName = str(child.name);
        if (!childName) continue;
        const alias = namespace === "functions" ? childName : `${namespace}__${childName}`;
        if (namespace !== "functions") {
          lowering.namespaceAliases.set(alias, { namespace, name: childName });
          lowering.bareToAlias.set(childName, alias);
        }
        let tool: Tool | undefined;
        if (child.type === "custom") {
          lowering.customTools.add(alias);
          tool = { name: alias, description: str(child.description) ?? "", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } };
        } else {
          tool = functionTool(child, alias);
        }
        if (!tool) continue;
        if (nsDescription) tool.description = `[${namespace}] ${nsDescription}\n${tool.description ?? ""}`.trim();
        add(tool);
      }
    } else if (type && HOSTED_TOOL_TYPES.has(type)) {
      lowering.droppedTools.push(type);
    } else if (type) {
      lowering.droppedTools.push(type);
      lowering.warnings.push(`unknown tool type "${type}" dropped`);
    }
  }
  // A bare name used by both a top-level function and a namespace child is not an alias.
  for (const tool of out) if (lowering.bareToAlias.get(tool.name) !== undefined && !lowering.namespaceAliases.has(tool.name)) lowering.bareToAlias.delete(tool.name);
  return out;
}

function functionTool(entry: Record<string, unknown>, nameOverride?: string): Tool | undefined {
  const name = nameOverride ?? str(entry.name);
  if (!name) return undefined;
  const parameters = isRecord(entry.parameters) ? (entry.parameters as JsonObject) : { type: "object", properties: {} };
  const tool: Tool = { name, parameters };
  const description = str(entry.description);
  if (description) tool.description = description;
  if (entry.strict === true) tool.strict = true;
  return tool;
}

function parseToolChoice(raw: unknown, lowering: Lowering, turn: Turn): ToolChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  if (!isRecord(raw)) return undefined;
  const type = str(raw.type);
  if (type === "function" || type === "custom") {
    const name = str(raw.name);
    if (!name) return undefined;
    return { name: lowering.bareToAlias.get(name) ?? name };
  }
  if (type === "allowed_tools") {
    const names = new Set<string>();
    const list = Array.isArray(raw.tools) ? raw.tools : [];
    for (const t of list) if (isRecord(t) && typeof t.name === "string") names.add(lowering.bareToAlias.get(t.name) ?? t.name);
    if (turn.tools && names.size > 0) {
      const kept = turn.tools.filter(t => names.has(t.name));
      if (kept.length > 0) turn.tools = kept;
    }
    return raw.mode === "required" ? "required" : "auto";
  }
  return "auto";
}

function parseInput(raw: unknown, systemParts: string[], lowering: Lowering, toolNames: Set<string>): Message[] {
  const messages: Message[] = [];
  let pendingReasoning: AssistantPart[] = [];
  const callNames = new Map<string, string>();

  const flushReasoningInto = (parts: AssistantPart[]): AssistantPart[] => {
    const merged = [...pendingReasoning, ...parts];
    pendingReasoning = [];
    return merged;
  };
  const lastAssistant = (): AssistantMessage | undefined => {
    const last = messages[messages.length - 1];
    return last && last.role === "assistant" ? last : undefined;
  };
  const pushToolCall = (callId: string, name: string, args: string): void => {
    const part: AssistantPart = { type: "tool_call", id: callId, name, arguments: args };
    const target = lastAssistant();
    if (target && pendingReasoning.length === 0) target.content.push(part);
    else messages.push({ role: "assistant", content: flushReasoningInto([part]) });
    callNames.set(callId, name);
  };

  if (typeof raw === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: raw }] });
    return messages;
  }
  if (!Array.isArray(raw)) throw new IngressError(400, "invalid_request", "input must be a string or an array of items");

  for (const item of raw) {
    if (!isRecord(item)) throw new IngressError(400, "invalid_request", "input items must be objects");
    const type = str(item.type) ?? (typeof item.role === "string" ? "message" : undefined);
    switch (type) {
      case "message": {
        const role = str(item.role);
        if (role === "system" || role === "developer") {
          const text = textOf(item.content);
          if (text) systemParts.push(text);
        } else if (role === "user") {
          messages.push({ role: "user", content: userParts(item.content) });
        } else if (role === "assistant") {
          const text = textOf(item.content);
          const parts: AssistantPart[] = text ? [{ type: "text", text }] : [];
          const merged = flushReasoningInto(parts);
          if (merged.length > 0) messages.push({ role: "assistant", content: merged });
        } else {
          throw new IngressError(400, "invalid_request", `unsupported message role "${role}"`);
        }
        break;
      }
      case "function_call": {
        const callId = str(item.call_id) ?? str(item.id);
        const rawName = str(item.name);
        if (!callId || !rawName) throw new IngressError(400, "invalid_request", "function_call needs call_id and name");
        const namespace = str(item.namespace);
        const name = namespace && namespace !== "functions" ? `${namespace}__${rawName}` : toolNames.has(rawName) ? rawName : (lowering.bareToAlias.get(rawName) ?? rawName);
        pushToolCall(callId, name, typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}));
        break;
      }
      case "custom_tool_call": {
        const callId = str(item.call_id) ?? str(item.id);
        const name = str(item.name);
        if (!callId || !name) throw new IngressError(400, "invalid_request", "custom_tool_call needs call_id and name");
        if (!lowering.customTools.has(name)) {
          throw new IngressError(
            400,
            "unsupported",
            `custom_tool_call "${name}" is not declared in this request's tools. If this is Codex's Responses Lite dialect, use a provider/model name so Codex sends the classic dialect, or route this model through a passthrough provider (wire openai-responses).`,
          );
        }
        pushToolCall(callId, name, JSON.stringify({ input: str(item.input) ?? "" }));
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = str(item.call_id);
        if (!callId) throw new IngressError(400, "invalid_request", `${type} needs call_id`);
        const content = toolResultParts(item.output);
        const message: ToolMessage = { role: "tool", callId, content };
        const name = callNames.get(callId);
        if (name) message.name = name;
        messages.push(message);
        pendingReasoning = [];
        break;
      }
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.map(s => (isRecord(s) ? (str(s.text) ?? "") : "")).filter(Boolean).join("\n") : "";
        const part: AssistantPart = { type: "reasoning" };
        if (summary) part.text = summary;
        const encrypted = str(item.encrypted_content);
        if (encrypted) {
          const opaque = decodeOpaque(encrypted);
          if (opaque) part.opaque = opaque;
          else lowering.warnings.push("dropped a reasoning item minted by another backend");
        }
        if (part.text || part.opaque) pendingReasoning.push(part);
        break;
      }
      case "additional_tools": {
        throw new IngressError(
          400,
          "unsupported",
          "this request uses Codex's Responses Lite dialect (`additional_tools`), which only Codex's own backend serves. Use a provider/model name so Codex sends the classic dialect, or route this model through a passthrough provider (wire openai-responses).",
        );
      }
      case "item_reference":
        throw new IngressError(400, "unsupported", "item_reference needs server-side state, which modelplug does not keep; send the full transcript");
      default:
        if (type && DROPPED_ITEM_TYPES.has(type)) {
          lowering.warnings.push(`dropped input item "${type}"`);
          break;
        }
        throw new IngressError(400, "invalid_request", `unsupported input item type "${type ?? "undefined"}"`);
    }
  }
  if (pendingReasoning.length > 0) messages.push({ role: "assistant", content: pendingReasoning });
  return messages;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => (isRecord(part) && (part.type === "input_text" || part.type === "output_text" || part.type === "text") ? (str(part.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function userParts(content: unknown): UserPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: UserPart[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "input_text" || part.type === "text") {
      const text = str(part.text);
      if (text !== undefined) out.push({ type: "text", text });
    } else if (part.type === "input_image") {
      const image = imagePart(part);
      if (image) out.push(image);
    } else if (part.type === "input_file") {
      throw new IngressError(400, "unsupported", "input_file is not supported");
    }
  }
  return out;
}

function toolResultParts(output: unknown): ToolResultPart[] {
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (!Array.isArray(output)) return [{ type: "text", text: output === undefined || output === null ? "" : JSON.stringify(output) }];
  const out: ToolResultPart[] = [];
  for (const part of output) {
    if (!isRecord(part)) continue;
    if (part.type === "input_text" || part.type === "text" || part.type === "output_text") {
      const text = str(part.text);
      if (text !== undefined) out.push({ type: "text", text });
    } else if (part.type === "input_image") {
      const image = imagePart(part);
      if (image && image.type === "image") out.push(image);
      else if (image) out.push({ type: "text", text: `[image: ${image.url}]` });
    }
  }
  return out;
}

function imagePart(part: Record<string, unknown>): ImagePart | { type: "image_url"; url: string } | undefined {
  const url = str(part.image_url) ?? (isRecord(part.image_url) ? str(part.image_url.url) : undefined);
  if (!url) return undefined;
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (match && match[2]) {
    const image: ImagePart = { type: "image", mediaType: match[1]!, data: match[3]! };
    return image;
  }
  return { type: "image_url", url };
}

/* ------------------------------------------------------------ respond */

export interface RespondOptions {
  now?: () => number;
  /** HTTP status for a failure that happens before any output, in non-streaming mode. */
  errorStatus?: (kind: ErrorKind) => number;
}

interface OpenReasoning {
  id: string;
  index: number;
  text: string;
  opaque?: Opaque;
  partAdded: boolean;
}
interface OpenMessage {
  id: string;
  index: number;
  text: string;
}
interface OpenCall {
  itemId: string;
  index: number;
  callId: string;
  name: string;
  args: string;
  custom: boolean;
  namespace?: { namespace: string; name: string };
  /** Custom tools only: progress of decoding the raw input out of the lowered `{"input":"…"}` arguments. */
  decoded?: { at: number; opened: boolean; closed: boolean };
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Decode as much of the lowered arguments as has arrived and return the newly
 * decoded raw input text, so `custom_tool_call_input.delta` carries the tool's
 * input the way the native backend streams it, not JSON. An escape that is
 * still incomplete, or a high surrogate without its pair, waits for more bytes.
 * The final `input` comes from a full JSON.parse at `tool_call_end`.
 */
function decodeCustomInputProgress(call: OpenCall): string {
  const state = (call.decoded ??= { at: 0, opened: false, closed: false });
  if (state.closed) return "";
  const args = call.args;
  if (!state.opened) {
    const match = /"input"\s*:\s*"/.exec(args);
    if (!match) return "";
    state.opened = true;
    state.at = match.index + match[0].length;
  }
  let out = "";
  let i = state.at;
  while (i < args.length) {
    const ch = args[i]!;
    if (ch === '"') {
      state.closed = true;
      i++;
      break;
    }
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = args.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = args.slice(i + 6, i + 12);
        if (!/^\\u[0-9a-fA-F]{4}$/.test(low)) break;
        out += String.fromCharCode(code, parseInt(low.slice(2), 16));
        i += 12;
      } else {
        out += String.fromCharCode(code);
        i += 6;
      }
      continue;
    }
    const mapped = SIMPLE_ESCAPES[next];
    if (mapped === undefined) break;
    out += mapped;
    i += 2;
  }
  state.at = i;
  return out;
}

const uid = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;

export async function respondResponses(events: AsyncIterable<Event>, parsed: ParsedResponses, sink: ResponseSink, options: RespondOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const responseId = uid("resp");
  const createdAt = Math.floor(now() / 1000);
  const output: JsonObject[] = [];
  let seq = 0;
  let nextIndex = 0;
  let reasoning: OpenReasoning | undefined;
  let message: OpenMessage | undefined;
  const calls = new Map<string, OpenCall>();
  const streamed: string[] = [];
  let started = false;

  const emit = (type: string, data: JsonObject): void => {
    const frame = encodeSse(type, JSON.stringify({ type, sequence_number: seq++, ...data }));
    if (parsed.stream) {
      if (!started) {
        started = true;
        sink.status(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      }
      sink.write(frame);
    } else {
      streamed.push(frame);
    }
  };

  const base = (status: string): JsonObject => {
    const r: JsonObject = {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model: parsed.modelRef,
      output,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      parallel_tool_calls: parsed.turn.parallelToolCalls ?? true,
      store: false,
      tool_choice: typeof parsed.turn.toolChoice === "string" ? parsed.turn.toolChoice : "auto",
      tools: [],
      text: { format: { type: "text" } },
      usage: null,
    };
    if (parsed.reasoning) r.reasoning = parsed.reasoning;
    return r;
  };

  const usageJson = (usage: Usage | undefined): JsonObject => ({
    input_tokens: usage?.inputTokens ?? 0,
    input_tokens_details: { cached_tokens: usage?.cachedInputTokens ?? 0, ...(usage?.cacheWriteTokens !== undefined ? { cache_write_tokens: usage.cacheWriteTokens } : {}) },
    output_tokens: usage?.outputTokens ?? 0,
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
    total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  });

  const openReasoning = (): OpenReasoning => {
    if (reasoning) return reasoning;
    closeMessage("completed");
    reasoning = { id: uid("rs"), index: nextIndex++, text: "", partAdded: false };
    emit("response.output_item.added", { output_index: reasoning.index, item: { id: reasoning.id, type: "reasoning", summary: [] } });
    return reasoning;
  };
  const closeReasoning = (): void => {
    if (!reasoning) return;
    const r = reasoning;
    reasoning = undefined;
    const summary: JsonObject[] = r.text ? [{ type: "summary_text", text: r.text }] : [];
    if (r.partAdded) {
      emit("response.reasoning_summary_text.done", { item_id: r.id, output_index: r.index, summary_index: 0, text: r.text });
      emit("response.reasoning_summary_part.done", { item_id: r.id, output_index: r.index, summary_index: 0, part: { type: "summary_text", text: r.text } });
    }
    const item: JsonObject = { id: r.id, type: "reasoning", summary };
    if (r.opaque) item.encrypted_content = encodeOpaque(r.opaque);
    output.push(item);
    emit("response.output_item.done", { output_index: r.index, item });
  };
  const openMessage = (): OpenMessage => {
    if (message) return message;
    closeReasoning();
    message = { id: uid("msg"), index: nextIndex++, text: "" };
    emit("response.output_item.added", { output_index: message.index, item: { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
    emit("response.content_part.added", { item_id: message.id, output_index: message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
    return message;
  };
  const closeMessage = (status: "completed" | "incomplete"): void => {
    if (!message) return;
    const m = message;
    message = undefined;
    emit("response.output_text.done", { item_id: m.id, output_index: m.index, content_index: 0, text: m.text, logprobs: [] });
    emit("response.content_part.done", { item_id: m.id, output_index: m.index, content_index: 0, part: { type: "output_text", text: m.text, annotations: [], logprobs: [] } });
    const item: JsonObject = { id: m.id, type: "message", status, role: "assistant", content: [{ type: "output_text", text: m.text, annotations: [], logprobs: [] }] };
    output.push(item);
    emit("response.output_item.done", { output_index: m.index, item });
  };
  const callItem = (c: OpenCall, status: string, args?: string): JsonObject => {
    if (c.custom) {
      let input = c.args;
      try {
        const parsedArgs = JSON.parse(c.args || "{}") as { input?: unknown };
        if (typeof parsedArgs.input === "string") input = parsedArgs.input;
      } catch {
        /* keep raw */
      }
      return { id: c.itemId, type: "custom_tool_call", status, call_id: c.callId, name: c.name, input };
    }
    const item: JsonObject = { id: c.itemId, type: "function_call", status, call_id: c.callId, name: c.namespace ? c.namespace.name : c.name, arguments: args ?? c.args };
    if (c.namespace) item.namespace = c.namespace.namespace;
    return item;
  };
  const closeCall = (c: OpenCall, ok: boolean): void => {
    calls.delete(c.callId);
    if (ok) {
      if (c.custom) {
        const item = callItem(c, "completed");
        emit("response.custom_tool_call_input.done", { item_id: c.itemId, output_index: c.index, input: item.input });
        output.push(item);
        emit("response.output_item.done", { output_index: c.index, item });
      } else {
        emit("response.function_call_arguments.done", { item_id: c.itemId, output_index: c.index, arguments: c.args });
        const item = callItem(c, "completed");
        output.push(item);
        emit("response.output_item.done", { output_index: c.index, item });
      }
    } else {
      const item = callItem(c, "incomplete");
      output.push(item);
      emit("response.output_item.done", { output_index: c.index, item });
    }
  };
  const finish = (status: "completed" | "incomplete" | "failed", usage: Usage | undefined, extra: JsonObject): void => {
    closeReasoning();
    closeMessage(status === "completed" ? "completed" : "incomplete");
    for (const c of [...calls.values()]) closeCall(c, false);
    const response = { ...base(status), usage: usageJson(usage), ...extra };
    emit(`response.${status}`, { response });
  };

  const fail = (kind: ErrorKind, code: string, messageText: string): void => {
    finish("failed", undefined, { error: { code, message: messageText } });
    if (!parsed.stream) {
      const status = output.length > 0 ? 200 : (options.errorStatus?.(kind) ?? 502);
      sink.status(status, { "content-type": "application/json; charset=utf-8" });
      sink.write(JSON.stringify({ error: { message: messageText, type: kind === "invalid_request" ? "invalid_request_error" : "server_error", code } }));
    }
  };

  emit("response.created", { response: base("in_progress") });
  emit("response.in_progress", { response: base("in_progress") });

  let finished = false;
  let finalResponse: JsonObject | undefined;
  for await (const event of events) {
    if (finished) break;
    switch (event.type) {
      case "reasoning_delta": {
        const r = openReasoning();
        if (!r.partAdded) {
          r.partAdded = true;
          emit("response.reasoning_summary_part.added", { item_id: r.id, output_index: r.index, summary_index: 0, part: { type: "summary_text", text: "" } });
        }
        r.text += event.text;
        emit("response.reasoning_summary_text.delta", { item_id: r.id, output_index: r.index, summary_index: 0, delta: event.text });
        break;
      }
      case "reasoning_opaque": {
        const r = openReasoning();
        r.opaque = event.opaque;
        break;
      }
      case "text_delta": {
        const m = openMessage();
        m.text += event.text;
        emit("response.output_text.delta", { item_id: m.id, output_index: m.index, content_index: 0, delta: event.text, logprobs: [] });
        break;
      }
      case "tool_call_start": {
        closeReasoning();
        closeMessage("completed");
        const alias = parsed.lowering.namespaceAliases.get(event.name);
        const call: OpenCall = { itemId: uid(parsed.lowering.customTools.has(event.name) ? "ctc" : "fc"), index: nextIndex++, callId: event.id, name: event.name, args: "", custom: parsed.lowering.customTools.has(event.name) };
        if (alias) call.namespace = alias;
        calls.set(event.id, call);
        emit("response.output_item.added", { output_index: call.index, item: callItem(call, "in_progress", "") });
        break;
      }
      case "tool_call_delta": {
        const call = calls.get(event.id);
        if (!call) break;
        call.args += event.argumentsDelta;
        if (call.custom) {
          const text = decodeCustomInputProgress(call);
          if (text) emit("response.custom_tool_call_input.delta", { item_id: call.itemId, output_index: call.index, delta: text });
        } else emit("response.function_call_arguments.delta", { item_id: call.itemId, output_index: call.index, delta: event.argumentsDelta });
        break;
      }
      case "tool_call_end": {
        const call = calls.get(event.id);
        if (!call) break;
        if (!argumentsUsable(call.args)) {
          closeCall(call, false);
          fail("upstream", "invalid_tool_arguments", `the model returned tool arguments for "${call.name}" that are not valid JSON`);
          finished = true;
          break;
        }
        closeCall(call, true);
        break;
      }
      case "done": {
        finished = true;
        if (event.stopReason === "max_tokens") finish("incomplete", event.usage, { incomplete_details: { reason: "max_output_tokens" } });
        else if (event.stopReason === "content_filter") finish("incomplete", event.usage, { incomplete_details: { reason: "content_filter" } });
        else finish("completed", event.usage, {});
        break;
      }
      case "error": {
        finished = true;
        fail(event.error.kind, event.error.kind, `${event.error.provider}: ${event.error.message}`);
        break;
      }
    }
  }
  if (!finished) fail("upstream", "stream_ended", "the upstream stream ended without a terminal event");

  if (parsed.stream) {
    sink.end();
    return;
  }
  // Non-streaming: the last emitted frame carries the terminal response object.
  const last = streamed[streamed.length - 1];
  if (last) {
    const dataLine = last.split("\n").find(l => l.startsWith("data: "));
    if (dataLine) {
      const parsedFrame = JSON.parse(dataLine.slice(6)) as { response?: JsonObject };
      finalResponse = parsedFrame.response;
    }
  }
  if (finalResponse && finalResponse.status !== "failed") {
    sink.status(200, { "content-type": "application/json; charset=utf-8" });
    sink.write(JSON.stringify(finalResponse));
  } else if (finalResponse && output.length > 0) {
    sink.status(200, { "content-type": "application/json; charset=utf-8" });
    sink.write(JSON.stringify(finalResponse));
  }
  sink.end();
}

function argumentsUsable(args: string): boolean {
  if (args.trim().length === 0) return true;
  try {
    const parsed: unknown = JSON.parse(args);
    return !!parsed && typeof parsed === "object";
  } catch {
    return false;
  }
}
