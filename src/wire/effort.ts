/** Effort levels shared by the wires that speak them. */
import type { ReasoningEffort } from "../ir.ts";

export const EFFORT_ORDER: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The nearest level the model accepts, rounding up; the top level when nothing above fits. */
export function clampEffort(effort: ReasoningEffort, levels: ReasoningEffort[] | undefined): ReasoningEffort {
  if (!levels || levels.length === 0 || levels.includes(effort)) return effort;
  const wanted = EFFORT_ORDER.indexOf(effort);
  const sorted = [...levels].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  for (const level of sorted) if (EFFORT_ORDER.indexOf(level) >= wanted) return level;
  return sorted[sorted.length - 1]!;
}
