import type { Wire, WireName } from "../ir.ts";
import { openaiChatWire } from "./openai-chat.ts";
import { openaiResponsesWire } from "./openai-responses.ts";

/** Wires available in this build. Missing entries are milestones, not bugs. */
export const WIRES: Partial<Record<WireName, Wire>> = {
  "openai-responses": openaiResponsesWire,
  "openai-chat": openaiChatWire,
};
