import type { ResolvedConfig } from "./config.ts";

export interface RouteTarget {
  provider: string;
  model: string;
}

export class RouteError extends Error {
  readonly code: "unknown_provider" | "no_default_provider" | "alias_cycle" | "alias_too_deep";
  constructor(code: RouteError["code"], message: string) {
    super(message);
    this.name = "RouteError";
    this.code = code;
  }
}

const MAX_ALIAS_DEPTH = 8;

/**
 * Turn the model reference a client wrote into an ordered list of concrete
 * targets. `provider/model` is explicit; a bare model goes to the default
 * provider or the only provider; an alias expands recursively and its list
 * order is the fallback order.
 */
export function resolveRoute(config: ResolvedConfig, modelRef: string): RouteTarget[] {
  const targets = expand(config, modelRef.trim(), 0, new Set());
  const seen = new Set<string>();
  return targets.filter(t => {
    const key = `${t.provider}/${t.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expand(config: ResolvedConfig, ref: string, depth: number, visiting: Set<string>): RouteTarget[] {
  const alias = config.aliases[ref];
  if (alias) {
    if (visiting.has(ref)) throw new RouteError("alias_cycle", `alias "${ref}" refers to itself`);
    if (depth >= MAX_ALIAS_DEPTH) throw new RouteError("alias_too_deep", `alias "${ref}" nests deeper than ${MAX_ALIAS_DEPTH}`);
    visiting.add(ref);
    const out = alias.flatMap(entry => expand(config, entry, depth + 1, visiting));
    visiting.delete(ref);
    return out;
  }
  return [parseRef(config, ref)];
}

function parseRef(config: ResolvedConfig, ref: string): RouteTarget {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const provider = ref.slice(0, slash);
    if (config.providers[provider]) return { provider, model: ref.slice(slash + 1) };
  }
  if (config.defaultProvider) return { provider: config.defaultProvider, model: ref };
  const names = Object.keys(config.providers);
  if (names.length === 1) return { provider: names[0]!, model: ref };
  if (slash > 0) {
    throw new RouteError(
      "unknown_provider",
      `"${ref.slice(0, slash)}" is not a configured provider (have: ${names.join(", ")})`,
    );
  }
  throw new RouteError(
    "no_default_provider",
    `"${ref}" has no provider prefix and no defaultProvider is set (have: ${names.join(", ")})`,
  );
}
