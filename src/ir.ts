/**
 * modelplug intermediate representation (IR).
 *
 * Everything pivots here. Ingress modules turn a client request into a `Turn`;
 * wire modules turn a `Turn` into an upstream request and the upstream stream
 * into `Event`s; ingress modules turn `Event`s back into the client protocol.
 *
 * Rules that keep this file small:
 *   - Nothing here names a provider. A provider-specific need becomes either a
 *     `Capabilities` value or an `Opaque` blob, never a new event type.
 *   - Adding a field is a deliberate contract change. Prefer a fixture in the
 *     wire that needs it, and only widen the IR when two wires need the same thing.
 */

export type JsonObject = { [key: string]: unknown };

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "max";

/* ------------------------------------------------------------------ input */

/** One model call, after routing. */
export interface Turn {
  /** Provider-native model id. */
  model: string;
  /** System and developer instructions, already merged into one text. */
  system?: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  reasoning?: ReasoningRequest;
  sampling?: Sampling;
  responseFormat?: ResponseFormat;
  /** Client identifiers for logs only. Never sent upstream. */
  metadata?: { requestId?: string; conversationId?: string };
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface UserMessage {
  role: "user";
  content: UserPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantPart[];
}

export interface ToolMessage {
  role: "tool";
  callId: string;
  name?: string;
  content: ToolResultPart[];
  isError?: boolean;
}

export type TextPart = { type: "text"; text: string };
/** Inline image, base64 payload. */
export type ImagePart = { type: "image"; mediaType: string; data: string };
export type ImageUrlPart = { type: "image_url"; url: string };
export type ReasoningPart = { type: "reasoning"; text?: string; opaque?: Opaque };
export type ToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  /** JSON text exactly as the model produced it. */
  arguments: string;
  opaque?: Opaque;
};

export type UserPart = TextPart | ImagePart | ImageUrlPart;
export type ToolResultPart = TextPart | ImagePart;
export type AssistantPart = TextPart | ReasoningPart | ToolCallPart;

/**
 * Provider-bound bytes that must be replayed verbatim to the provider that
 * minted them: thinking signatures, encrypted reasoning, thought signatures.
 *
 * Only the wire named in `provider` may interpret `data`; every other module
 * carries it untouched. A wire that receives an Opaque minted by a different
 * provider drops it. This is how modelplug stays stateless: the client's own
 * transcript is the replay store.
 */
export interface Opaque {
  provider: string;
  model?: string;
  kind: string;
  data: string;
}

export interface Tool {
  name: string;
  description?: string;
  parameters: JsonObject;
  strict?: boolean;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface ReasoningRequest {
  effort?: ReasoningEffort;
  /** Wires that speak budgets use this; wires that speak effort derive one when absent. */
  budgetTokens?: number;
  summary?: "auto" | "none";
}

export interface Sampling {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
}

export type ResponseFormat =
  | { type: "json_schema"; name: string; schema: JsonObject; strict?: boolean }
  | { type: "json" };

/* ----------------------------------------------------------------- output */

/**
 * Streamed output. A decode must yield exactly one terminal event, `done` or
 * `error`, and nothing after it.
 */
export type Event =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_opaque"; opaque: Opaque }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string; opaque?: Opaque }
  | { type: "done"; stopReason: StopReason; usage?: Usage }
  | { type: "error"; error: WireError };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "content_filter" | "cancelled";

export interface Usage {
  /** Total input tokens, inclusive of cache reads and writes. */
  inputTokens: number;
  /** Total output tokens, inclusive of reasoning. */
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "overloaded"
  | "invalid_request"
  | "context_length"
  | "not_found"
  | "content_filter"
  | "upstream"
  | "network"
  | "cancelled";

/**
 * Classified once, by the wire that understands the upstream format. The
 * attempt loop reads `retryable` and `retryAfterMs` and nothing else; no module
 * outside a wire may match on upstream error text.
 */
export interface WireError {
  kind: ErrorKind;
  message: string;
  provider: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
}

/* ----------------------------------------------------------- capabilities */

export type ReasoningWire =
  /** Model has no reasoning controls. */
  | "none"
  /** Request carries an effort level (OpenAI style). */
  | "effort"
  /** Request carries a token budget (Anthropic, Gemini style). */
  | "budget"
  /** Chat Completions dialect that streams `reasoning_content` and takes no control field. */
  | "reasoning_content"
  /** Chat Completions dialect with a vendor on/off switch; see `reasoningToggle`. */
  | "toggle";

/**
 * The closed set of ways a provider or model may differ. Resolved once per
 * route from wire defaults, a preset, and user overrides. If a new difference
 * cannot be expressed here, it becomes a named middleware in the wire with a
 * fixture, not a flag.
 */
export interface Capabilities {
  reasoning: ReasoningWire;
  /** Only for `toggle`: the request field that switches thinking on. */
  reasoningToggle?: { field: string; on: unknown; off?: unknown };
  /** Only for `effort`: levels the model accepts, ascending. */
  reasoningLevels?: ReasoningEffort[];
  tools: boolean;
  images: boolean;
  temperature: boolean;
  stream: "sse" | "ndjson";
  contextWindow?: number;
  maxOutputTokens?: number;
}

/* ------------------------------------------------------- module contracts */

export type WireName = "openai-chat" | "openai-responses" | "anthropic" | "gemini";
export type IngressName = "responses" | "messages";

export interface ProviderTarget {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface WireRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * A wire speaks one upstream protocol. It never retries, never chooses
 * credentials, and never names a provider other than through `target`.
 */
export interface Wire {
  readonly name: WireName;
  encode(turn: Turn, caps: Capabilities, target: ProviderTarget, stream: boolean): WireRequest;
  /** Reads a 2xx body and yields events, ending with exactly one `done` or `error`. */
  decode(response: Response, caps: Capabilities, target: ProviderTarget): AsyncIterable<Event>;
  /** Classifies a non-2xx response from its status, headers and body text. */
  classifyError(status: number, headers: Headers, bodyText: string, target: ProviderTarget): WireError;
}

export interface ParsedIngress {
  /** The model reference as the client wrote it, before routing. */
  modelRef: string;
  turn: Turn;
  stream: boolean;
}

export interface ResponseSink {
  status(code: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

/** An ingress speaks one client protocol. */
export interface Ingress {
  readonly name: IngressName;
  parse(body: unknown, headers: Headers): ParsedIngress;
  respond(events: AsyncIterable<Event>, parsed: ParsedIngress, sink: ResponseSink): Promise<void>;
}
