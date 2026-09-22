/**
 * OpenAI Responses wire. Today only `classifyError` is real: the responses
 * ingress reaches this wire through the same-protocol passthrough, which
 * relays bytes. `encode` and `decode` arrive with the IR path in milestone 7.
 */
import type { Capabilities, ProviderTarget, Turn, Wire, WireError, WireRequest, Event } from "../ir.ts";
import { classifyOpenAiError } from "./openai-errors.ts";
import { openaiModelsRequest, parseOpenaiModels } from "./openai-models.ts";

export { retryAfterMsFrom, upstreamErrorMessage } from "./openai-errors.ts";
export const classifyResponsesError = classifyOpenAiError;

const NOT_YET = "openai-responses encode/decode arrive in milestone 7; this build relays Responses requests as-is";

export const openaiResponsesWire: Wire = {
  name: "openai-responses",
  encode(_turn: Turn, _caps: Capabilities, _target: ProviderTarget, _stream: boolean): WireRequest {
    throw new Error(NOT_YET);
  },
  // eslint-disable-next-line require-yield
  async *decode(_response: Response, _caps: Capabilities, _target: ProviderTarget): AsyncIterable<Event> {
    throw new Error(NOT_YET);
  },
  classifyError(status: number, headers: Headers, bodyText: string, target: ProviderTarget): WireError {
    return classifyOpenAiError(status, headers, bodyText, target.name);
  },
  modelsRequest: openaiModelsRequest,
  parseModels: parseOpenaiModels,
};
