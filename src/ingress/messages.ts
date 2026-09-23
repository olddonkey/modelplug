/** Messages ingress: client transcript to IR, and IR events to Messages output. */
import { randomBytes } from "node:crypto";
import type {
  AssistantPart, ErrorKind, Event, ImagePart, Ingress, JsonObject, Message,
  Opaque, ParsedIngress, ReasoningEffort, ResponseSink, Tool, ToolResultPart, Turn,
  Usage, UserPart,
} from "../ir.ts";
import { encodeSse } from "../sse.ts";
import { decodeOpaqueEnvelope, encodeOpaque, IngressError } from "./responses.ts";
import type { RespondOptions } from "./responses.ts";

export interface ParsedMessages extends ParsedIngress {
  lowering: { droppedTools: string[]; warnings: string[] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const bad = (message: string): never => { throw new IngressError(400, "invalid_request", message); };
const unsupported = (type: string): never => { throw new IngressError(400, "unsupported", `unsupported content block type "${type}"`); };

function image(block: Record<string, unknown>): UserPart {
  const source = block.source;
  if (!isRecord(source)) return bad("image source must be an object");
  if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
    return { type: "image", mediaType: source.media_type, data: source.data };
  }
  if (source.type === "url" && typeof source.url === "string") return { type: "image_url", url: source.url };
  return bad(`unsupported image source type "${str(source.type) ?? "undefined"}"`);
}

function blocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : bad("message content must not be empty");
  if (!Array.isArray(content) || content.length === 0) return bad("message content must not be empty");
  return content.map((block: unknown) => isRecord(block) ? block : bad("content blocks must be objects"));
}

function resultParts(raw: unknown): ToolResultPart[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  const out: ToolResultPart[] = [];
  for (const block of blocks(raw)) {
    if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      const part = image(block);
      if (part.type !== "image") unsupported("image source url in tool_result");
      out.push(part as ImagePart);
    } else unsupported(str(block.type) ?? "undefined");
  }
  return out;
}

const DROPPED_BLOCKS = new Set([
  "fallback", "compaction", "server_tool_use", "web_search_tool_result", "web_search_result",
  "web_fetch_tool_result", "web_fetch_result", "code_execution_tool_result", "code_execution_result",
  "tool_search_tool_result", "tool_search_result", "tool_reference", "mcp_tool_result", "memory_tool_result",
]);
const EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseMessagesRequest(body: unknown): ParsedMessages {
  if (!isRecord(body)) return bad("request body must be a JSON object");
  const modelRef = str(body.model)?.trim();
  if (!modelRef) return bad("model is required");
  const lowering: ParsedMessages["lowering"] = { droppedTools: [], warnings: [] };
  const turn: Turn = { model: modelRef, messages: [] };
  if (typeof body.system === "string") {
    if (body.system) turn.system = body.system;
  } else if (Array.isArray(body.system)) {
    const parts: string[] = [];
    for (const block of body.system) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return bad("system blocks must be text blocks");
      parts.push(block.text);
    }
    if (parts.length > 0) turn.system = parts.join("\n\n");
  } else if (body.system !== undefined) return bad("system must be a string or text blocks");

  if (!Array.isArray(body.messages) || body.messages.length === 0) return bad("messages must be a non-empty array beginning with a user message");
  if (!isRecord(body.messages[0]) || body.messages[0].role !== "user") return bad("messages must begin with a user message");
  const callNames = new Map<string, string>();
  for (const raw of body.messages) {
    if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant")) return bad(`unsupported message role "${isRecord(raw) ? str(raw.role) ?? "undefined" : "undefined"}"`);
    const content = blocks(raw.content);
    if (raw.role === "user") {
      const parts: UserPart[] = [];
      const results: Message[] = [];
      for (const block of content) {
        switch (block.type) {
          case "text":
            if (typeof block.text !== "string") return bad("text block needs text");
            parts.push({ type: "text", text: block.text });
            break;
          case "image": parts.push(image(block)); break;
          case "tool_result": {
            const callId = str(block.tool_use_id);
            if (!callId) return bad("tool_result needs tool_use_id");
            const result: Message = { role: "tool", callId, content: resultParts(block.content) };
            const name = callNames.get(callId);
            if (name) result.name = name;
            if (block.is_error === true) result.isError = true;
            results.push(result);
            break;
          }
          case "document": unsupported("document");
          default: unsupported(str(block.type) ?? "undefined");
        }
      }
      turn.messages.push(...results);
      if (parts.length > 0) turn.messages.push({ role: "user", content: parts });
    } else {
      const parts: AssistantPart[] = [];
      const callOpaques: Array<{ callId: string; opaque: Opaque; part?: AssistantPart }> = [];
      for (const block of content) {
        switch (block.type) {
          case "text":
            if (typeof block.text !== "string") return bad("text block needs text");
            parts.push({ type: "text", text: block.text });
            break;
          case "tool_use": {
            const id = str(block.id), name = str(block.name);
            if (!id || !name || !isRecord(block.input)) return bad("tool_use needs id, name and object input");
            parts.push({ type: "tool_call", id, name, arguments: JSON.stringify(block.input) });
            callNames.set(id, name);
            break;
          }
          case "thinking": {
            if (typeof block.thinking !== "string") return bad("thinking block needs thinking text");
            const part: AssistantPart = { type: "reasoning", text: block.thinking };
            if (typeof block.signature === "string") {
              const envelope = decodeOpaqueEnvelope(block.signature);
              if (envelope?.callId) {
                callOpaques.push({ callId: envelope.callId, opaque: envelope.opaque, part });
                parts.push(part);
                break;
              }
              if (envelope) part.opaque = envelope.opaque;
              else lowering.warnings.push("dropped a thinking signature minted by another backend");
            }
            parts.push(part);
            break;
          }
          case "redacted_thinking": {
            const envelope = typeof block.data === "string" ? decodeOpaqueEnvelope(block.data) : undefined;
            if (envelope?.callId) callOpaques.push({ callId: envelope.callId, opaque: envelope.opaque });
            else if (envelope) parts.push({ type: "reasoning", opaque: envelope.opaque });
            else lowering.warnings.push("dropped a redacted thinking block minted by another backend");
            break;
          }
          default: {
            const type = str(block.type) ?? "undefined";
            if (DROPPED_BLOCKS.has(type)) lowering.warnings.push(`dropped assistant content block "${type}"`);
            else unsupported(type);
          }
        }
      }
      for (const { callId, opaque, part } of callOpaques) {
        const call = parts.toReversed().find(part => part.type === "tool_call" && part.id === callId)
          ?? turn.messages.toReversed().flatMap(message => message.role === "assistant" ? message.content.toReversed() : []).find(part => part.type === "tool_call" && part.id === callId);
        if (call?.type === "tool_call") call.opaque = opaque;
        else {
          if (part) parts.splice(parts.indexOf(part), 1);
          lowering.warnings.push(`dropped a tool-call opaque for unknown call id "${callId}"`);
        }
      }
      if (parts.length > 0) turn.messages.push({ role: "assistant", content: parts });
    }
  }

  if (Array.isArray(body.tools)) {
    const tools: Tool[] = [];
    for (const raw of body.tools) {
      if (!isRecord(raw)) return bad("tools must contain objects");
      if (raw.type !== undefined && raw.type !== "custom") {
        lowering.droppedTools.push(str(raw.type) ?? "undefined");
        continue;
      }
      const name = str(raw.name);
      if (!name || !isRecord(raw.input_schema)) return bad("custom tools need name and input_schema");
      const tool: Tool = { name, parameters: raw.input_schema as JsonObject };
      if (typeof raw.description === "string") tool.description = raw.description;
      if (typeof raw.strict === "boolean") tool.strict = raw.strict;
      tools.push(tool);
    }
    if (tools.length > 0) turn.tools = tools;
  }
  if (isRecord(body.tool_choice)) {
    switch (body.tool_choice.type) {
      case "auto": turn.toolChoice = "auto"; break;
      case "none": turn.toolChoice = "none"; break;
      case "any": turn.toolChoice = "required"; break;
      case "tool": {
        const name = str(body.tool_choice.name);
        if (!name) return bad("tool_choice tool needs name");
        turn.toolChoice = { name };
        break;
      }
      default: return bad(`unsupported tool_choice type "${str(body.tool_choice.type) ?? "undefined"}"`);
    }
    if (body.tool_choice.disable_parallel_tool_use === true) turn.parallelToolCalls = false;
  }
  const rawEffort = isRecord(body.output_config) ? body.output_config.effort : undefined;
  const outputEffort = typeof rawEffort === "string" && EFFORTS.has(rawEffort as ReasoningEffort) ? rawEffort as ReasoningEffort : undefined;
  if (isRecord(body.thinking)) {
    if (body.thinking.type === "adaptive") {
      turn.reasoning = { effort: outputEffort ?? "high" };
    } else if (body.thinking.type === "enabled") {
      const budget = body.thinking.budget_tokens;
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return bad("enabled thinking needs budget_tokens");
      const effort: ReasoningEffort = budget <= 2048 ? "low" : budget <= 8192 ? "medium" : budget <= 16384 ? "high" : budget <= 24576 ? "xhigh" : "max";
      turn.reasoning = { budgetTokens: budget, effort };
    }
  } else if (body.thinking === undefined && outputEffort !== undefined) turn.reasoning = { effort: outputEffort };
  if (isRecord(body.output_config) && isRecord(body.output_config.format) && body.output_config.format.type === "json_schema" && isRecord(body.output_config.format.schema)) {
    turn.responseFormat = { type: "json_schema", name: "response", schema: body.output_config.format.schema as JsonObject };
  }
  const sampling: NonNullable<Turn["sampling"]> = {};
  if (typeof body.max_tokens === "number") sampling.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === "number") sampling.temperature = body.temperature;
  if (typeof body.top_p === "number") sampling.topP = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.every(s => typeof s === "string")) sampling.stop = body.stop_sequences;
  if (Object.keys(sampling).length > 0) turn.sampling = sampling;
  if (isRecord(body.metadata) && typeof body.metadata.user_id === "string") turn.metadata = { conversationId: body.metadata.user_id };
  return { modelRef, turn, stream: body.stream === true, lowering };
}

/** Estimate input tokens from the lowered Messages request; this is not an exact tokenizer. */
export function estimateInputTokens(parsed: ParsedMessages): number {
  const turn = parsed.turn;
  let bytes = Buffer.byteLength(turn.system ?? "", "utf8");
  let images = 0;
  for (const message of turn.messages) {
    for (const part of message.content) {
      if (part.type === "text") bytes += Buffer.byteLength(part.text, "utf8");
      else if (part.type === "image" || part.type === "image_url") images += 1;
    }
  }
  for (const tool of turn.tools ?? []) {
    bytes += Buffer.byteLength(tool.name, "utf8");
    bytes += Buffer.byteLength(tool.description ?? "", "utf8");
    bytes += Buffer.byteLength(JSON.stringify(tool.parameters), "utf8");
  }
  return Math.ceil(bytes / 4) + images * 1500;
}

type Block = JsonObject;
const usageJson = (usage?: Usage): JsonObject => ({
  input_tokens: Math.max(0, (usage?.inputTokens ?? 0) - (usage?.cachedInputTokens ?? 0) - (usage?.cacheWriteTokens ?? 0)),
  cache_creation_input_tokens: usage?.cacheWriteTokens ?? 0,
  cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
  output_tokens: usage?.outputTokens ?? 0,
});
const errorType = (kind: ErrorKind): string => {
  switch (kind) {
    case "auth": return "authentication_error";
    case "rate_limit": case "quota": return "rate_limit_error";
    case "overloaded": return "overloaded_error";
    case "invalid_request": case "context_length": case "content_filter": return "invalid_request_error";
    case "not_found": return "not_found_error";
    default: return "api_error";
  }
};
// Message IDs are msg_ plus 24 lowercase hex characters, matching the sibling ingress's random ID size.
const messageId = (): string => `msg_${randomBytes(12).toString("hex")}`;

export async function respondMessages(events: AsyncIterable<Event>, parsed: ParsedMessages, sink: ResponseSink, options: RespondOptions = {}): Promise<void> {
  // stop_sequence is always null: the IR reports a stop reason, not which requested sequence matched.
  const message: JsonObject = { id: messageId(), type: "message", role: "assistant", model: parsed.modelRef, content: [] as Block[], stop_reason: null, stop_sequence: null, usage: usageJson() };
  const content = message.content as Block[];
  let started = false;
  let open: { kind: "text" | "thinking"; block: Block; index: number } | undefined;
  const calls = new Map<string, { id: string; name: string; args: string; chunks: string[]; input?: JsonObject; opaque?: Opaque }>();
  const emit = (type: string, data: JsonObject): void => { if (parsed.stream) sink.write(encodeSse(type, JSON.stringify({ type, ...data }))); };
  const start = (): void => {
    if (started) return;
    started = true;
    if (parsed.stream) {
      sink.status(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      emit("message_start", { message: { ...message, content: [] } });
      emit("ping", {});
    }
  };
  const close = (): void => {
    if (!open) return;
    emit("content_block_stop", { index: open.index });
    open = undefined;
  };
  const openBlock = (kind: "text" | "thinking"): { block: Block; index: number } => {
    start();
    if (open?.kind === kind) return open;
    close();
    const block: Block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
    const index = content.length;
    content.push(block);
    open = { kind, block, index };
    emit("content_block_start", { index, content_block: { ...block } });
    return open;
  };
  const fail = (kind: ErrorKind, messageText: string): void => {
    const error = { type: errorType(kind), message: messageText };
    if (parsed.stream && started) emit("error", { error });
    else {
      sink.status(options.errorStatus?.(kind) ?? 502, { "content-type": "application/json; charset=utf-8" });
      sink.write(JSON.stringify({ type: "error", error }));
    }
  };
  const flushCalls = (): void => {
    // Parallel calls can finish out of order; their blocks retain start order.
    for (const call of calls.values()) {
      if (!call.input) break;
      close();
      const index = content.length;
      const block: Block = { type: "tool_use", id: call.id, name: call.name, input: call.input };
      content.push(block);
      emit("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
      for (const chunk of call.chunks) emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: chunk } });
      emit("content_block_stop", { index });
      if (call.opaque) {
        const block: Block = { type: "redacted_thinking", data: encodeOpaque(call.opaque, call.id) };
        const opaqueIndex = content.length;
        content.push(block);
        emit("content_block_start", { index: opaqueIndex, content_block: block });
        emit("content_block_stop", { index: opaqueIndex });
      }
      calls.delete(call.id);
    }
  };
  let finished = false;
  for await (const event of events) {
    if (finished) break;
    switch (event.type) {
      case "text_delta": {
        const { block, index } = openBlock("text");
        block.text = String(block.text) + event.text;
        emit("content_block_delta", { index, delta: { type: "text_delta", text: event.text } });
        break;
      }
      case "reasoning_delta": {
        const { block, index } = openBlock("thinking");
        block.thinking = String(block.thinking) + event.text;
        emit("content_block_delta", { index, delta: { type: "thinking_delta", thinking: event.text } });
        break;
      }
      case "reasoning_opaque": {
        if (event.opaque.kind === "redacted_thinking") {
          start(); close();
          const block = { type: "redacted_thinking", data: encodeOpaque(event.opaque) };
          const index = content.length;
          content.push(block);
          emit("content_block_start", { index, content_block: block });
          emit("content_block_stop", { index });
        } else {
          const { block, index } = openBlock("thinking");
          block.signature = encodeOpaque(event.opaque);
          emit("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
          close();
        }
        break;
      }
      case "tool_call_start":
        // The model has started producing output, even while we hold the call
        // until its JSON validates. A bad call therefore ends with an SSE error.
        start();
        calls.set(event.id, { id: event.id, name: event.name, args: "", chunks: [] });
        break;
      case "tool_call_delta": {
        const call = calls.get(event.id);
        if (call) {
          call.args += event.argumentsDelta;
          call.chunks.push(event.argumentsDelta);
        }
        break;
      }
      case "tool_call_end": {
        const call = calls.get(event.id);
        if (!call) break;
        let input: unknown;
        try { input = JSON.parse(call.args || "{}"); } catch { input = undefined; }
        if (!isRecord(input)) {
          fail("invalid_request", "the model returned tool arguments that are not valid JSON");
          finished = true;
          break;
        }
        call.input = input as JsonObject;
        if (event.opaque) call.opaque = event.opaque;
        flushCalls();
        break;
      }
      case "done": {
        start(); close();
        const stopReason = event.stopReason === "content_filter" ? "refusal" : event.stopReason === "cancelled" ? "end_turn" : event.stopReason;
        message.stop_reason = stopReason;
        message.usage = usageJson(event.usage);
        emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: message.usage as JsonObject });
        emit("message_stop", {});
        finished = true;
        break;
      }
      case "error": fail(event.error.kind, event.error.message); finished = true; break;
    }
  }
  if (!finished) fail("upstream", "the upstream stream ended without a terminal event");
  if (!parsed.stream && message.stop_reason !== null) {
    sink.status(200, { "content-type": "application/json; charset=utf-8" });
    sink.write(JSON.stringify(message));
  }
  sink.end();
}

export const messagesIngress: Ingress = {
  name: "messages",
  parse: (body, _headers) => parseMessagesRequest(body),
  respond: (events, parsed, sink) => respondMessages(events, parsed as ParsedMessages, sink),
};
