/**
 * OpenAI Chat Completions wire: the lingua franca of DeepSeek, Kimi, Qwen,
 * GLM, Groq, OpenRouter, Ollama, vLLM and most gateways. Provider differences
 * come in through `Capabilities` only.
 */
import { randomBytes } from "node:crypto";
import type { AssistantMessage, Capabilities, Event, Message, ProviderTarget, ReasoningEffort, ToolMessage, Turn, Usage, UserMessage, Wire, WireError, WireRequest } from "../ir.ts";
import { decodeNdjson, decodeSse } from "../sse.ts";
import { classifyOpenAiError } from "./openai-errors.ts";

const EFFORT_ORDER: ReasoningEffort[] = ["minimal", "low", "medium", "high", "max"];

function clampEffort(effort: ReasoningEffort, levels: ReasoningEffort[] | undefined): ReasoningEffort {
  if (!levels || levels.length === 0 || levels.includes(effort)) return effort;
  const wanted = EFFORT_ORDER.indexOf(effort);
  const sorted = [...levels].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  for (const level of sorted) if (EFFORT_ORDER.indexOf(level) >= wanted) return level;
  return sorted[sorted.length - 1]!;
}

function imageUrl(part: { type: "image"; mediaType: string; data: string } | { type: "image_url"; url: string }): string {
  return part.type === "image" ? `data:${part.mediaType};base64,${part.data}` : part.url;
}

function userMessage(message: UserMessage, caps: Capabilities): Record<string, unknown> {
  const texts = message.content.filter(p => p.type === "text");
  const images = message.content.filter(p => p.type !== "text");
  if (images.length === 0) return { role: "user", content: texts.map(p => p.text).join("\n") };
  if (!caps.images) {
    return { role: "user", content: [...texts.map(p => p.text), `[${images.length} image(s) omitted: this model does not accept images]`].join("\n") };
  }
  const content: Array<Record<string, unknown>> = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else content.push({ type: "image_url", image_url: { url: imageUrl(part) } });
  }
  return { role: "user", content };
}

function assistantMessage(message: AssistantMessage): Record<string, unknown> | undefined {
  const text = message.content.filter(p => p.type === "text").map(p => p.text).join("");
  const calls = message.content.filter(p => p.type === "tool_call");
  if (!text && calls.length === 0) return undefined;
  const out: Record<string, unknown> = { role: "assistant" };
  if (text) out.content = text;
  if (calls.length > 0) out.tool_calls = calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
  return out;
}

function toolMessages(message: ToolMessage, caps: Capabilities): Array<Record<string, unknown>> {
  const texts = message.content.filter(p => p.type === "text").map(p => p.text);
  const images = message.content.filter(p => p.type === "image");
  const out: Array<Record<string, unknown>> = [];
  const content = images.length > 0 ? [...texts, caps.images ? "[image attached in the next message]" : "[image omitted: this model does not accept images]"].join("\n") : texts.join("\n");
  out.push({ role: "tool", tool_call_id: message.callId, content });
  if (images.length > 0 && caps.images) {
    out.push({
      role: "user",
      content: [{ type: "text", text: `Image returned by tool call ${message.callId}:` }, ...images.map(i => ({ type: "image_url", image_url: { url: imageUrl(i) } }))],
    });
  }
  return out;
}

export function encodeChatRequest(turn: Turn, caps: Capabilities, target: ProviderTarget, stream: boolean): WireRequest {
  const messages: Array<Record<string, unknown>> = [];
  if (turn.system) messages.push({ role: "system", content: turn.system });
  for (const message of turn.messages as Message[]) {
    if (message.role === "user") messages.push(userMessage(message, caps));
    else if (message.role === "assistant") {
      const encoded = assistantMessage(message);
      if (encoded) messages.push(encoded);
    } else messages.push(...toolMessages(message, caps));
  }
  const body: Record<string, unknown> = { model: turn.model, messages, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (caps.tools && turn.tools && turn.tools.length > 0) {
    body.tools = turn.tools.map(t => {
      const fn: Record<string, unknown> = { name: t.name, parameters: t.parameters };
      if (t.description) fn.description = t.description;
      if (t.strict) fn.strict = true;
      return { type: "function", function: fn };
    });
    if (turn.toolChoice !== undefined) {
      body.tool_choice = typeof turn.toolChoice === "string" ? turn.toolChoice : { type: "function", function: { name: turn.toolChoice.name } };
    }
    if (turn.parallelToolCalls !== undefined) body.parallel_tool_calls = turn.parallelToolCalls;
  }
  if (turn.sampling) {
    if (caps.temperature && turn.sampling.temperature !== undefined) body.temperature = turn.sampling.temperature;
    if (caps.temperature && turn.sampling.topP !== undefined) body.top_p = turn.sampling.topP;
    if (turn.sampling.maxOutputTokens !== undefined) body.max_tokens = turn.sampling.maxOutputTokens;
    if (turn.sampling.stop && turn.sampling.stop.length > 0) body.stop = turn.sampling.stop;
  }
  if (!("max_tokens" in body) && caps.maxOutputTokens) body.max_tokens = caps.maxOutputTokens;
  if (turn.responseFormat) {
    body.response_format =
      turn.responseFormat.type === "json_schema"
        ? { type: "json_schema", json_schema: { name: turn.responseFormat.name, schema: turn.responseFormat.schema, ...(turn.responseFormat.strict ? { strict: true } : {}) } }
        : { type: "json_object" };
  }
  const effort = turn.reasoning?.effort;
  if (caps.reasoning === "effort" && effort) body.reasoning_effort = clampEffort(effort, caps.reasoningLevels);
  if (caps.reasoning === "toggle" && caps.reasoningToggle) {
    const on = effort !== undefined && effort !== "minimal";
    if (on) body[caps.reasoningToggle.field] = caps.reasoningToggle.on;
    else if (caps.reasoningToggle.off !== undefined) body[caps.reasoningToggle.field] = caps.reasoningToggle.off;
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...(target.headers ?? {}) };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  return { url: `${target.baseUrl}/chat/completions`, method: "POST", headers, body: JSON.stringify(body) };
}

export function usageFromChat(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = num(u.prompt_tokens);
  const output = num(u.completion_tokens);
  if (input === undefined && output === undefined) return undefined;
  const usage: Usage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const cached = num(promptDetails.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
  const reasoning = num(completionDetails.reasoning_tokens);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

interface PendingCall {
  id: string;
  name?: string;
  args: string;
  started: boolean;
  order: number;
}

async function* sseData(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  for await (const message of decodeSse(body)) yield message.data;
}

export async function* decodeChatStream(response: Response, caps: Capabilities, target: ProviderTarget): AsyncGenerator<Event> {
  const provider = target.name;
  const calls = new Map<number, PendingCall>();
  let order = 0;
  let finish: string | undefined;
  let usage: Usage | undefined;
  let sawContent = false;
  const frames = caps.stream === "ndjson" ? decodeNdjson(response.body) : sseData(response.body);

  const startCall = function* (call: PendingCall): Generator<Event> {
    if (call.started) return;
    call.started = true;
    yield { type: "tool_call_start", id: call.id, name: call.name ?? "" };
    if (call.args) yield { type: "tool_call_delta", id: call.id, argumentsDelta: call.args };
  };

  try {
    for await (const data of frames) {
      if (data.trim() === "[DONE]") break;
      let chunk: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object") continue;
        chunk = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (chunk.error !== undefined && chunk.error !== null) {
        yield { type: "error", error: classifyOpenAiError(response.status, response.headers, JSON.stringify(chunk), provider) };
        return;
      }
      if (chunk.usage) usage = usageFromChat(chunk.usage) ?? usage;
      const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : [];
      const choice = choices[0];
      if (!choice) continue;
      const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) yield { type: "reasoning_delta", text: reasoning };
      if (typeof delta.content === "string" && delta.content.length > 0) {
        sawContent = true;
        yield { type: "text_delta", text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = typeof raw.index === "number" ? raw.index : 0;
          let call = calls.get(index);
          if (!call) {
            call = { id: typeof raw.id === "string" && raw.id ? raw.id : `call_${randomBytes(8).toString("hex")}`, args: "", started: false, order: order++ };
            calls.set(index, call);
          } else if (typeof raw.id === "string" && raw.id && !call.started) {
            call.id = raw.id;
          }
          const fn = (raw.function ?? {}) as Record<string, unknown>;
          if (typeof fn.name === "string" && fn.name && !call.name) call.name = fn.name;
          const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
          if (!call.started && call.name) {
            call.args += argumentsDelta;
            yield* startCall(call);
          } else if (call.started) {
            call.args += argumentsDelta;
            if (argumentsDelta) yield { type: "tool_call_delta", id: call.id, argumentsDelta };
          } else {
            call.args += argumentsDelta;
          }
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (err) {
    yield { type: "error", error: { kind: "network", message: `stream interrupted: ${err instanceof Error ? err.message : String(err)}`, provider, retryable: false } };
    return;
  }

  const ordered = [...calls.values()].sort((a, b) => a.order - b.order);
  for (const call of ordered) {
    if (!call.started) {
      if (!call.name) {
        yield { type: "error", error: { kind: "upstream", message: "the model streamed a tool call without a name", provider, retryable: false } };
        return;
      }
      yield* startCall(call);
    }
    yield { type: "tool_call_end", id: call.id };
  }
  if (!finish && !sawContent && ordered.length === 0) {
    yield { type: "error", error: { kind: "upstream", message: "the stream ended without content or a finish_reason", provider, retryable: true } };
    return;
  }
  const stopReason = finish === "length" ? "max_tokens" : finish === "content_filter" ? "content_filter" : ordered.length > 0 || finish === "tool_calls" ? "tool_use" : "end_turn";
  const done: Event = { type: "done", stopReason };
  if (usage) done.usage = usage;
  yield done;
}

export const openaiChatWire: Wire = {
  name: "openai-chat",
  encode: encodeChatRequest,
  decode: decodeChatStream,
  classifyError(status: number, headers: Headers, bodyText: string, target: ProviderTarget): WireError {
    return classifyOpenAiError(status, headers, bodyText, target.name);
  },
};
