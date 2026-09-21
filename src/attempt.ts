import type { WireError } from "./ir.ts";
import type { RouteTarget } from "./route.ts";

export interface AttemptPolicy {
  maxAttemptsPerTarget: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_ATTEMPT_POLICY: AttemptPolicy = {
  maxAttemptsPerTarget: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; error: WireError };

export interface AttemptFailure {
  target: RouteTarget;
  attempt: number;
  error: WireError;
}

export class RouteExhaustedError extends Error {
  readonly failures: AttemptFailure[];
  constructor(failures: AttemptFailure[]) {
    const last = failures.at(-1);
    super(
      last
        ? `all ${new Set(failures.map(f => f.target.provider + "/" + f.target.model)).size} target(s) failed; last: ${last.error.kind} from ${last.target.provider}: ${last.error.message}`
        : "no targets to try",
    );
    this.name = "RouteExhaustedError";
    this.failures = failures;
  }
  /** The error the client should see: the last non-retryable one, else the last one. */
  get clientError(): WireError | undefined {
    return [...this.failures].reverse().find(f => !f.error.retryable)?.error ?? this.failures.at(-1)?.error;
  }
}

export interface AttemptOptions {
  signal?: AbortSignal;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to full jitter in [0.8, 1.2). */
  jitter?: () => number;
}

export interface AttemptResult<T> {
  value: T;
  target: RouteTarget;
  attempt: number;
  failures: AttemptFailure[];
}

/**
 * The only retry loop in modelplug.
 *
 * `run` must resolve only once the upstream response is known good, meaning a
 * 2xx status and, for streams, the first decoded event. Nothing is ever
 * retried after bytes have reached the client. A retryable error is retried on
 * the same target up to the policy's limit, then the next target is tried. A
 * non-retryable error moves to the next target immediately.
 */
export async function runAttempts<T>(
  targets: RouteTarget[],
  run: (target: RouteTarget, attempt: number) => Promise<AttemptOutcome<T>>,
  policy: AttemptPolicy = DEFAULT_ATTEMPT_POLICY,
  options: AttemptOptions = {},
): Promise<AttemptResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? (() => 0.8 + Math.random() * 0.4);
  const failures: AttemptFailure[] = [];

  for (const target of targets) {
    for (let attempt = 1; attempt <= policy.maxAttemptsPerTarget; attempt++) {
      throwIfAborted(options.signal);
      const outcome = await run(target, attempt);
      if (outcome.ok) return { value: outcome.value, target, attempt, failures };
      failures.push({ target, attempt, error: outcome.error });
      if (!outcome.error.retryable || outcome.error.kind === "cancelled") break;
      if (attempt === policy.maxAttemptsPerTarget) break;
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)) * jitter();
      const delay = outcome.error.retryAfterMs !== undefined
        ? Math.min(Math.max(outcome.error.retryAfterMs, 0), policy.maxDelayMs * 4)
        : backoff;
      if (delay > 0) await sleep(Math.round(delay));
    }
  }
  throw new RouteExhaustedError(failures);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error("aborted");
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
