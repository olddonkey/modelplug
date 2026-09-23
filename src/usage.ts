/** Append-only usage log: request metadata and token counts, never prompts or keys. */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "./ir.ts";

export interface UsageRecord {
  ts: string;
  ingress: "responses" | "messages";
  route: "responses" | "compact" | "messages" | "countTokens";
  modelRef: string;
  provider: string;
  model: string;
  credential: string;
  attempt: number;
  status: "ok" | "error";
  kind?: string;
  httpStatus?: number;
  usage?: Usage;
  durationMs: number;
}

export function defaultUsageLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(state, "modelplug", "usage.jsonl");
}

let warned = false;

export function appendUsage(path: string | null | undefined, record: UsageRecord, log: (msg: string) => void = console.error): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (err) {
    if (!warned) {
      warned = true;
      log(`usage log disabled: cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Map a Responses `usage` object to the IR shape. */
export function usageFromResponsesPayload(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const usage: Usage = { inputTokens: input, outputTokens: output };
  const cached = num(inputDetails.cached_tokens);
  const cacheWrite = num(inputDetails.cache_write_tokens);
  const reasoning = num(outputDetails.reasoning_tokens);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}
