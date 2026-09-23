/** OpenAI Responses wire for API-key providers. */
import type { Capabilities, Event, ProviderTarget, ReasoningEffort, Turn, Wire, WireError, WireRequest } from "../ir.ts";
import { decodeSse } from "../sse.ts";
import { usageFromResponsesPayload } from "../usage.ts";
import { classifyOpenAiError } from "./openai-errors.ts";
import { openaiModelsRequest, parseOpenaiModels } from "./openai-models.ts";

export { retryAfterMsFrom, upstreamErrorMessage } from "./openai-errors.ts";
export const classifyResponsesError = classifyOpenAiError;

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const order = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortFor(effort: ReasoningEffort, levels: ReasoningEffort[] | undefined): string {
  if (effort === "minimal" || !levels?.length || levels.includes(effort)) return effort;
  const sorted = [...levels].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted.find(level => order.indexOf(level) >= order.indexOf(effort)) ?? sorted.at(-1)!;
}

function imageUrl(p: { type: "image"; mediaType: string; data: string } | { type: "image_url"; url: string }): string {
  return p.type === "image" ? `data:${p.mediaType};base64,${p.data}` : p.url;
}

function requestHeaders(target: ProviderTarget, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...(target.headers ?? {}) };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  return headers;
}

export function encodeResponsesRequest(turn: Turn, caps: Capabilities, target: ProviderTarget, stream: boolean): WireRequest {
  const input: Array<Record<string, unknown>> = [];
  let reasoningIndex = 0;
  for (const message of turn.messages) {
    if (message.role === "user") {
      const content: Array<Record<string, unknown>> = [];
      let omitted = 0;
      for (const p of message.content) {
        if (p.type === "text") content.push({ type: "input_text", text: p.text });
        else if (caps.images) content.push({ type: "input_image", image_url: imageUrl(p), detail: "auto" });
        else omitted++;
      }
      if (omitted) content.push({ type: "input_text", text: `[${omitted} image(s) omitted: this model does not accept images]` });
      input.push({ type: "message", role: "user", content });
    } else if (message.role === "assistant") {
      let text: Array<Record<string, unknown>> = [];
      const flush = (): void => { if (text.length) input.push({ type: "message", role: "assistant", content: text }); text = []; };
      for (const p of message.content) {
        if (p.type === "text") text.push({ type: "output_text", text: p.text });
        else if (p.type === "reasoning") {
          flush();
          if (p.opaque?.kind === "encrypted_reasoning" && p.opaque.provider === target.name) {
            input.push({ type: "reasoning", id: `rs_${reasoningIndex++}`, summary: [], encrypted_content: p.opaque.data });
          }
        } else {
          flush();
          input.push({ type: "function_call", call_id: p.id, name: p.name, arguments: p.arguments });
        }
      }
      flush();
    } else {
      const texts = message.content.filter(p => p.type === "text").map(p => p.text);
      const images = message.content.filter(p => p.type === "image");
      if (images.length) texts.push(caps.images ? "[image attached in the next message]" : "[image omitted: this model does not accept images]");
      input.push({ type: "function_call_output", call_id: message.callId, output: texts.join("\n") });
      if (images.length && caps.images) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: `Image returned by tool call ${message.callId}:` }, ...images.map(p => ({ type: "input_image", image_url: imageUrl(p), detail: "auto" }))] });
    }
  }
  const body: Record<string, unknown> = { model: turn.model, input, store: false, include: ["reasoning.encrypted_content"], stream };
  if (turn.system) body.instructions = turn.system;
  if (caps.tools && turn.tools?.length) {
    body.tools = turn.tools.map(t => ({ type: "function", name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) }));
    if (turn.toolChoice !== undefined) body.tool_choice = typeof turn.toolChoice === "string" ? turn.toolChoice : { type: "function", name: turn.toolChoice.name };
    if (turn.parallelToolCalls !== undefined) body.parallel_tool_calls = turn.parallelToolCalls;
  }
  if (caps.reasoning === "effort" && turn.reasoning) {
    const reasoning: Record<string, unknown> = {};
    if (turn.reasoning.effort) reasoning.effort = effortFor(turn.reasoning.effort, caps.reasoningLevels);
    if (turn.reasoning.summary === "auto") reasoning.summary = "auto";
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
  }
  if (turn.sampling) {
    if (turn.sampling.maxOutputTokens !== undefined) body.max_output_tokens = turn.sampling.maxOutputTokens;
    if (caps.temperature && turn.sampling.temperature !== undefined) body.temperature = turn.sampling.temperature;
    if (caps.temperature && turn.sampling.topP !== undefined) body.top_p = turn.sampling.topP;
  }
  if (!("max_output_tokens" in body) && caps.maxOutputTokens) body.max_output_tokens = caps.maxOutputTokens;
  if (turn.responseFormat) body.text = { format: turn.responseFormat.type === "json_schema" ? { type: "json_schema", name: turn.responseFormat.name, schema: turn.responseFormat.schema, ...(turn.responseFormat.strict !== undefined ? { strict: turn.responseFormat.strict } : {}) } : { type: "json_object" } };
  return { url: `${target.baseUrl}/responses`, method: "POST", headers: requestHeaders(target, stream), body: JSON.stringify(body) };
}

interface Call { id: string; itemId?: string; index?: number; args: string; ended: boolean }

function streamError(value: unknown, provider: string): WireError {
  const e = object(value);
  const code = str(e.code) ?? str(e.type);
  const kind = code === "rate_limit_exceeded" ? "rate_limit" : code === "context_length_exceeded" ? "context_length" : code === "server_error" ? "upstream" : "invalid_request";
  return { kind, message: str(e.message) ?? code ?? "upstream response failed", provider, retryable: kind === "rate_limit" || kind === "upstream" };
}

export async function* decodeResponsesStream(response: Response, _caps: Capabilities, target: ProviderTarget): AsyncGenerator<Event> {
  const calls = new Map<string, Call>();
  let model: string | undefined;
  let emitted = false;
  let sawCall = false;
  const findCall = (event: Record<string, unknown>): Call | undefined => [...calls.values()].find(c =>
    (typeof event.item_id === "string" && c.itemId === event.item_id) || (typeof event.output_index === "number" && c.index === event.output_index));
  try {
    for await (const frame of decodeSse(response.body)) {
      if (frame.data === "[DONE]") break;
      let event: Record<string, unknown>;
      try { event = object(JSON.parse(frame.data) as unknown); } catch { continue; }
      const upstream = object(event.response);
      model = str(upstream.model) ?? model;
      const item = object(event.item);
      switch (event.type) {
        case "response.output_item.added": {
          if (item.type !== "function_call") break;
          const id = str(item.call_id), name = str(item.name);
          if (!id || !name) break;
          const call: Call = { id, args: "", ended: false };
          if (typeof item.id === "string") call.itemId = item.id;
          if (typeof event.output_index === "number") call.index = event.output_index;
          calls.set(id, call);
          sawCall = emitted = true;
          yield { type: "tool_call_start", id, name };
          break;
        }
        case "response.function_call_arguments.delta": {
          const call = findCall(event), delta = str(event.delta);
          if (call && !call.ended && delta) { call.args += delta; emitted = true; yield { type: "tool_call_delta", id: call.id, argumentsDelta: delta }; }
          break;
        }
        case "response.function_call_arguments.done": {
          const call = findCall(event), full = str(event.arguments);
          if (call && !call.ended && full?.startsWith(call.args) && full.length > call.args.length) {
            const delta = full.slice(call.args.length); call.args = full; emitted = true;
            yield { type: "tool_call_delta", id: call.id, argumentsDelta: delta };
          }
          break;
        }
        case "response.output_item.done": {
          if (item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.length) {
            emitted = true;
            yield { type: "reasoning_opaque", opaque: { provider: target.name, ...(model ? { model } : {}), kind: "encrypted_reasoning", data: item.encrypted_content } };
          } else if (item.type === "function_call") {
            const call = (str(item.call_id) ? calls.get(str(item.call_id)!) : undefined) ?? findCall(event);
            if (call && !call.ended) {
              const full = str(item.arguments);
              if (full?.startsWith(call.args) && full.length > call.args.length) {
                const delta = full.slice(call.args.length); call.args = full; emitted = true;
                yield { type: "tool_call_delta", id: call.id, argumentsDelta: delta };
              }
              call.ended = true;
              yield { type: "tool_call_end", id: call.id };
            }
          }
          break;
        }
        case "response.output_text.delta":
        case "response.reasoning_summary_text.delta": {
          const delta = str(event.delta);
          if (delta) { emitted = true; yield { type: event.type === "response.output_text.delta" ? "text_delta" : "reasoning_delta", text: delta }; }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          for (const call of calls.values()) if (!call.ended) { call.ended = true; yield { type: "tool_call_end", id: call.id }; }
          const reason = str(object(upstream.incomplete_details).reason);
          const incomplete = event.type === "response.incomplete" || upstream.status === "incomplete";
          const stopReason = incomplete ? (reason === "content_filter" ? "content_filter" : "max_tokens") : sawCall ? "tool_use" : "end_turn";
          const usage = usageFromResponsesPayload(upstream.usage);
          yield { type: "done", stopReason, ...(usage ? { usage } : {}) };
          return;
        }
        case "response.failed":
        case "error":
          yield { type: "error", error: streamError(upstream.error ?? event.error ?? event, target.name) };
          return;
        default: break;
      }
    }
  } catch (err) {
    yield { type: "error", error: { kind: "upstream", message: `stream interrupted: ${err instanceof Error ? err.message : String(err)}`, provider: target.name, retryable: !emitted } };
    return;
  }
  for (const call of calls.values()) if (!call.ended) { call.ended = true; yield { type: "tool_call_end", id: call.id }; }
  yield { type: "error", error: { kind: "upstream", message: "the stream ended without a terminal response event", provider: target.name, retryable: !emitted } };
}

export const openaiResponsesWire: Wire = {
  name: "openai-responses",
  encode: encodeResponsesRequest,
  decode: decodeResponsesStream,
  classifyError(status: number, headers: Headers, bodyText: string, target: ProviderTarget): WireError {
    return classifyOpenAiError(status, headers, bodyText, target.name);
  },
  modelsRequest: openaiModelsRequest,
  parseModels: parseOpenaiModels,
};
