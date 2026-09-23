import type { Wire, WireName } from "../ir.ts";
import { anthropicWire } from "./anthropic.ts";
import { openaiChatWire } from "./openai-chat.ts";
import { openaiResponsesWire } from "./openai-responses.ts";
import { geminiWire } from "./gemini.ts";

/** Wires available in this build. Missing entries are milestones, not bugs. */
export const WIRES: Partial<Record<WireName, Wire>> = {
  "openai-responses": openaiResponsesWire,
  "openai-chat": openaiChatWire,
  anthropic: anthropicWire,
  gemini: geminiWire,
};
