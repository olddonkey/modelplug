/** Gemini GenerateContent wire. Frames and request shapes follow the public API. */
import type { Capabilities, Event, JsonObject, ProviderTarget, ReasoningEffort, Turn, Usage, Wire, WireError, WireRequest } from "../ir.ts";
import { decodeSse } from "../sse.ts";
import { retryAfterMsFrom } from "./openai-errors.ts";

const OMIT = new Set(["additionalProperties", "$schema", "$id", "default", "examples", "title", "strict", "pattern", "minLength", "maxLength", "minimum", "maximum", "const"]);
const FORMATS = new Set(["enum", "date-time", "date"]);
const BUDGET: Record<ReasoningEffort | "xhigh", number> = { minimal: 0, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return a new schema; never mutate the caller's tool or response schema. */
export function sanitizeSchema(schema: JsonObject): JsonObject {
  const visit = (node: Record<string, unknown>): JsonObject => {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (OMIT.has(key) || (key === "format" && !FORMATS.has(String(value)))) continue;
      if (key === "properties" && record(value)) {
        result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, record(child) ? visit(child) : child]));
      } else if (key === "items" && record(value)) result[key] = visit(value);
      else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) result[key] = value.map(child => record(child) ? visit(child) : child);
      else if (key === "type" && Array.isArray(value)) {
        const types = value.filter(t => typeof t === "string" && t !== "null");
        if (types.length > 0) result.type = types[0];
        if (value.includes("null")) result.nullable = true;
      } else result[key] = value;
    }
    return result;
  };
  return visit(schema);
}

function imageUrlPart(url: string): JsonObject {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
  const extension = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "image/jpeg";
  return { fileData: { fileUri: url, mimeType } };
}

function parsedArgs(text: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text);
    return record(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function encodeGeminiRequest(turn: Turn, caps: Capabilities, target: ProviderTarget, stream: boolean): WireRequest {
  const contents: Array<{ role: "user" | "model"; parts: JsonObject[] }> = [];
  const append = (role: "user" | "model", parts: JsonObject[]): void => {
    if (parts.length === 0) return;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of turn.messages) {
    if (message.role === "user") {
      const parts: JsonObject[] = [];
      for (const part of message.content) {
        if (part.type === "text") parts.push({ text: part.text });
        else if (!caps.images) parts.push({ text: "[image omitted: this model does not accept images]" });
        else if (part.type === "image") parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } });
        else parts.push(imageUrlPart(part.url));
      }
      append("user", parts);
    } else if (message.role === "assistant") {
      const parts: JsonObject[] = [];
      for (const part of message.content) {
        if (part.type === "text") parts.push({ text: part.text });
        if (part.type === "tool_call") {
          const call: JsonObject = { functionCall: { name: part.name, args: parsedArgs(part.arguments) } };
          if (part.opaque?.provider === target.name && part.opaque.kind === "thought_signature") call.thoughtSignature = part.opaque.data;
          parts.push(call);
        }
      }
      append("model", parts);
    } else {
      const texts = message.content.filter(p => p.type === "text").map(p => p.text);
      const images = message.content.filter(p => p.type === "image");
      if (images.length > 0 && !caps.images) texts.push(`[${images.length} image(s) omitted: this model does not accept images]`);
      const name = message.name || message.callId;
      const response: JsonObject = { output: texts.join("\n") };
      if (message.isError) response.error = true;
      const parts: JsonObject[] = [{ functionResponse: { name, response } }];
      if (caps.images) for (const image of images) parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
      append("user", parts);
    }
  }
  const body: JsonObject = { contents };
  if (turn.system) body.systemInstruction = { parts: [{ text: turn.system }] };
  if (caps.tools && turn.tools?.length) {
    body.tools = [{ functionDeclarations: turn.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: sanitizeSchema(tool.parameters) })) }];
    if (turn.toolChoice !== undefined) {
      const choice = turn.toolChoice;
      body.toolConfig = { functionCallingConfig: typeof choice === "object" ? { mode: "ANY", allowedFunctionNames: [choice.name] } : { mode: choice === "none" ? "NONE" : choice === "required" ? "ANY" : "AUTO" } };
    }
  }
  const generation: JsonObject = {};
  const sampling = turn.sampling;
  if (sampling?.maxOutputTokens !== undefined) generation.maxOutputTokens = sampling.maxOutputTokens;
  else if (caps.maxOutputTokens !== undefined) generation.maxOutputTokens = caps.maxOutputTokens;
  if (caps.temperature && sampling?.temperature !== undefined) generation.temperature = sampling.temperature;
  if (caps.temperature && sampling?.topP !== undefined) generation.topP = sampling.topP;
  if (sampling?.stop?.length) generation.stopSequences = sampling.stop;
  if (turn.responseFormat) {
    generation.responseMimeType = "application/json";
    if (turn.responseFormat.type === "json_schema") generation.responseSchema = sanitizeSchema(turn.responseFormat.schema);
  }
  if (turn.reasoning && caps.reasoning === "budget") {
    const budget = turn.reasoning.budgetTokens ?? BUDGET[turn.reasoning.effort ?? "medium"];
    generation.thinkingConfig = budget === 0 ? { thinkingBudget: 0 } : { includeThoughts: true, thinkingBudget: budget };
  }
  if (Object.keys(generation).length) body.generationConfig = generation;
  const headers: Record<string, string> = { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}), ...(target.headers ?? {}) };
  if (target.apiKey) headers["x-goog-api-key"] = target.apiKey;
  return { url: `${target.baseUrl}/v1beta/models/${encodeURIComponent(turn.model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, method: "POST", headers, body: JSON.stringify(body) };
}

function usageFromGemini(value: unknown): Usage | undefined {
  if (!record(value)) return undefined;
  const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const input = number(value.promptTokenCount);
  const output = number(value.candidatesTokenCount);
  const thoughts = number(value.thoughtsTokenCount);
  if (input === undefined && output === undefined && thoughts === undefined) return undefined;
  const usage: Usage = { inputTokens: input ?? 0, outputTokens: (output ?? 0) + (thoughts ?? 0) };
  const cached = number(value.cachedContentTokenCount);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (thoughts !== undefined) usage.reasoningTokens = thoughts;
  return usage;
}

export function classifyGeminiError(status: number, headers: Headers, bodyText: string, target: ProviderTarget): WireError {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (record(parsed) && record(parsed.error)) detail = parsed.error;
  } catch { /* raw response */ }
  const code = typeof detail.code === "number" ? detail.code : status;
  const upstreamStatus = typeof detail.status === "string" ? detail.status : "";
  const message = typeof detail.message === "string" ? detail.message : bodyText.trim().slice(0, 300) || `HTTP ${code}`;
  const lower = `${upstreamStatus} ${message}`.toLowerCase();
  let kind: WireError["kind"] = "upstream";
  let retryable = false;
  if (code === 400 || upstreamStatus === "INVALID_ARGUMENT") kind = /context|too long|token limit|maximum.*tokens/i.test(lower) ? "context_length" : "invalid_request";
  else if (code === 401 || code === 403 || upstreamStatus === "UNAUTHENTICATED" || upstreamStatus === "PERMISSION_DENIED") kind = "auth";
  else if (code === 404 || upstreamStatus === "NOT_FOUND") kind = "not_found";
  else if (code === 429 || upstreamStatus === "RESOURCE_EXHAUSTED") {
    kind = /quota|billing|exceeded your current/i.test(lower) ? "quota" : "rate_limit";
    retryable = kind === "rate_limit";
  } else if (code === 503 || upstreamStatus === "UNAVAILABLE") { kind = "overloaded"; retryable = true; }
  else if (code === 500 || code === 504 || code >= 500) retryable = true;
  const error: WireError = { kind, message, provider: target.name, status: code, retryable };
  const retryAfter = retryAfterMsFrom(headers);
  if (retryAfter !== undefined) error.retryAfterMs = retryAfter;
  return error;
}

export async function* decodeGeminiStream(response: Response, _caps: Capabilities, target: ProviderTarget): AsyncGenerator<Event> {
  let calls = 0;
  let emitted = false;
  let sawCandidate = false;
  let finish: string | undefined;
  let usage: Usage | undefined;
  try {
    for await (const frame of decodeSse(response.body)) {
      let value: unknown;
      try { value = JSON.parse(frame.data); } catch { continue; }
      if (!record(value)) continue;
      if (value.error) {
        yield { type: "error", error: classifyGeminiError(response.status, response.headers, JSON.stringify(value), target) };
        return;
      }
      if (record(value.promptFeedback) && value.promptFeedback.blockReason && !sawCandidate) {
        yield { type: "error", error: { kind: "content_filter", message: `prompt blocked: ${String(value.promptFeedback.blockReason)}`, provider: target.name, retryable: false } };
        return;
      }
      if (value.usageMetadata) usage = usageFromGemini(value.usageMetadata) ?? usage;
      const candidate = Array.isArray(value.candidates) ? value.candidates[0] : undefined;
      if (!record(candidate)) continue;
      sawCandidate = true;
      const content = record(candidate.content) ? candidate.content : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts) {
        if (!record(part)) continue;
        if (typeof part.text === "string" && part.text.length) {
          emitted = true;
          yield { type: part.thought === true ? "reasoning_delta" : "text_delta", text: part.text };
        }
        if (record(part.functionCall) && typeof part.functionCall.name === "string") {
          const id = `call_${calls++}`;
          emitted = true;
          yield { type: "tool_call_start", id, name: part.functionCall.name };
          yield { type: "tool_call_delta", id, argumentsDelta: JSON.stringify(part.functionCall.args ?? {}) };
          const end: Event = { type: "tool_call_end", id };
          if (typeof part.thoughtSignature === "string") end.opaque = { provider: target.name, ...(typeof value.modelVersion === "string" ? { model: value.modelVersion } : {}), kind: "thought_signature", data: part.thoughtSignature };
          yield end;
        }
      }
      if (typeof candidate.finishReason === "string") finish = candidate.finishReason;
    }
  } catch (error) {
    yield { type: "error", error: { kind: "network", message: `stream interrupted: ${error instanceof Error ? error.message : String(error)}`, provider: target.name, retryable: !emitted } };
    return;
  }
  if (!finish) {
    yield { type: "error", error: { kind: "upstream", message: "the stream ended without a finishReason", provider: target.name, retryable: !emitted } };
    return;
  }
  const stopReason = finish === "MAX_TOKENS" ? "max_tokens" : ["SAFETY", "RECITATION", "PROHIBITED_CONTENT"].includes(finish) ? "content_filter" : calls > 0 && finish === "STOP" ? "tool_use" : "end_turn";
  const done: Event = { type: "done", stopReason };
  if (usage) done.usage = usage;
  yield done;
}

export function parseGeminiModels(body: unknown): string[] {
  if (!record(body) || !Array.isArray(body.models)) return [];
  return [...new Set(body.models.flatMap(model => record(model) && typeof model.name === "string" && model.name.startsWith("models/") ? [model.name.slice(7)] : []))].sort();
}

export const geminiWire: Wire & { passthroughHeaders(target: ProviderTarget): Record<string, string> } = {
  name: "gemini",
  encode: encodeGeminiRequest,
  decode: decodeGeminiStream,
  classifyError: classifyGeminiError,
  modelsRequest(target) { return { url: `${target.baseUrl}/v1beta/models`, headers: { ...(target.headers ?? {}), ...(target.apiKey ? { "x-goog-api-key": target.apiKey } : {}) } }; },
  parseModels: parseGeminiModels,
  passthroughHeaders(target) { return target.apiKey ? { "x-goog-api-key": target.apiKey } : {}; },
};
