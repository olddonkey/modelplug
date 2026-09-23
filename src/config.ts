import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ACCOUNT_STRATEGIES, CREDENTIAL_KINDS, PASSTHROUGH_BY_DEFAULT, type AccountStrategy, type CredentialKind } from "./credentials/kinds.ts";
import { PASSTHROUGH_WIRES, type Capabilities, type WireName } from "./ir.ts";

export const WIRES = ["openai-chat", "openai-responses", "anthropic", "gemini"] as const;
const REASONING = ["none", "effort", "budget", "reasoning_content", "toggle"] as const;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const capabilitiesSchema = z.strictObject({
  reasoning: z.enum(REASONING),
  reasoningToggle: z
    .strictObject({ field: z.string().min(1), on: z.unknown(), off: z.unknown().optional() })
    .optional(),
  reasoningLevels: z.array(z.enum(EFFORTS)).min(1).optional(),
  tools: z.boolean(),
  images: z.boolean(),
  temperature: z.boolean(),
  stream: z.enum(["sse", "ndjson"]),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

const presetSchema = z.strictObject({
  wire: z.enum(WIRES),
  baseUrl: z.string().optional(),
  credential: z.enum(CREDENTIAL_KINDS).optional(),
  passthrough: z.boolean().optional(),
  capabilities: capabilitiesSchema,
  note: z.string().optional(),
});

const PROVIDER_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

const providerSchema = z.strictObject({
  wire: z.enum(WIRES).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  preset: z.string().optional(),
  credential: z.enum(CREDENTIAL_KINDS).optional(),
  passthrough: z.boolean().optional(),
  /** Pools only: how an account is picked for a new conversation. */
  strategy: z.enum(ACCOUNT_STRATEGIES).optional(),
  models: z.array(z.string().min(1)).optional(),
  capabilities: capabilitiesSchema.partial().optional(),
});

export const configSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(10100),
  providers: z.record(z.string().regex(PROVIDER_NAME, "provider names are lowercase, no slash"), providerSchema),
  aliases: z.record(z.string().min(1), z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).default({}),
  defaultProvider: z.string().optional(),
  usageLog: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
type ProviderConfigInput = z.input<typeof providerSchema>;

export interface ResolvedProvider {
  name: string;
  wire: WireName;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  preset?: string;
  credential: CredentialKind;
  passthrough: boolean;
  strategy?: AccountStrategy;
  models: string[];
  capabilities: Capabilities;
}

export interface ResolvedConfig {
  host: string;
  port: number;
  providers: Record<string, ResolvedProvider>;
  aliases: Record<string, string[]>;
  defaultProvider?: string;
  usageLog: boolean;
  /** Where the config came from, for diagnostics. */
  source: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const WIRE_DEFAULT_CAPABILITIES: Record<WireName, Capabilities> = {
  "openai-chat": { reasoning: "none", tools: true, images: true, temperature: true, stream: "sse" },
  "openai-responses": {
    reasoning: "effort",
    reasoningLevels: ["low", "medium", "high"],
    tools: true,
    images: true,
    temperature: true,
    stream: "sse",
  },
  anthropic: { reasoning: "effort", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], tools: true, images: true, temperature: false, stream: "sse" },
  gemini: { reasoning: "budget", tools: true, images: true, temperature: true, stream: "sse" },
};

type Preset = z.infer<typeof presetSchema>;

let presetCache: Record<string, Preset> | undefined;

export function loadPresets(): Record<string, Preset> {
  if (presetCache) return presetCache;
  const raw = JSON.parse(readFileSync(new URL("./presets.json", import.meta.url), "utf8")) as Record<string, unknown>;
  delete raw.$comment;
  const parsed = z.record(z.string(), presetSchema).safeParse(raw);
  if (!parsed.success) throw new ConfigError(`presets.json is invalid:\n${z.prettifyError(parsed.error)}`);
  presetCache = parsed.data;
  return parsed.data;
}

/** Replace `${NAME}` in every string leaf. Missing variables fail as a group. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const found = env[name];
        if (found === undefined) {
          missing.add(name);
          return "";
        }
        return found;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  const result = walk(value);
  if (missing.size > 0) {
    throw new ConfigError(`missing environment variables: ${[...missing].sort().join(", ")}`);
  }
  return result;
}

export function parseConfig(raw: unknown, source: string): ResolvedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${source}: invalid config\n${z.prettifyError(parsed.error)}`);
  return resolveConfig(parsed.data, source);
}

export function resolveConfig(config: Config, source: string): ResolvedConfig {
  const presets = loadPresets();
  const providers: Record<string, ResolvedProvider> = {};
  const problems: string[] = [];

  for (const [name, p] of Object.entries(config.providers)) {
    const preset = p.preset ? presets[p.preset] : undefined;
    if (p.preset && !preset) {
      problems.push(`provider "${name}": unknown preset "${p.preset}" (known: ${Object.keys(presets).join(", ")})`);
      continue;
    }
    const wire = p.wire ?? preset?.wire;
    if (!wire) {
      problems.push(`provider "${name}": set "wire" or "preset"`);
      continue;
    }
    if (preset && p.wire && p.wire !== preset.wire) {
      problems.push(`provider "${name}": wire "${p.wire}" conflicts with preset "${p.preset}" (${preset.wire})`);
      continue;
    }
    const baseUrl = stripTrailingSlash(p.baseUrl ?? preset?.baseUrl);
    if (!baseUrl) {
      const withUrl = Object.entries(presets).filter(([, v]) => v.wire === wire && v.baseUrl).map(([k]) => k);
      problems.push(`provider "${name}": "baseUrl" is required for wire "${wire}"${withUrl.length > 0 ? ` (or use a preset that sets it: ${withUrl.join(", ")})` : ""}`);
      continue;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      problems.push(`provider "${name}": baseUrl must start with http:// or https://`);
      continue;
    }
    const capabilities: Capabilities = {
      ...WIRE_DEFAULT_CAPABILITIES[wire],
      ...stripUndefined(preset?.capabilities ?? {}),
      ...stripUndefined(p.capabilities ?? {}),
    };
    if (capabilities.reasoning === "toggle" && !capabilities.reasoningToggle) {
      problems.push(`provider "${name}": reasoning "toggle" needs "reasoningToggle"`);
      continue;
    }
    const credential = p.credential ?? preset?.credential ?? "api-key";
    const resolved: ResolvedProvider = {
      name,
      wire,
      baseUrl,
      headers: p.headers ?? {},
      credential,
      passthrough: p.passthrough ?? preset?.passthrough ?? (PASSTHROUGH_BY_DEFAULT.has(credential) || PASSTHROUGH_WIRES.has(wire)),
      models: p.models ?? [],
      capabilities,
    };
    if (p.apiKey !== undefined && p.apiKey !== "") resolved.apiKey = p.apiKey;
    if (p.preset !== undefined) resolved.preset = p.preset;
    if (p.strategy !== undefined) resolved.strategy = p.strategy;
    providers[name] = resolved;
  }

  if (config.defaultProvider && !config.providers[config.defaultProvider]) {
    problems.push(`defaultProvider "${config.defaultProvider}" is not a configured provider`);
  }

  const aliases: Record<string, string[]> = {};
  for (const [alias, value] of Object.entries(config.aliases)) {
    if (config.providers[alias]) problems.push(`alias "${alias}" collides with a provider name`);
    aliases[alias] = Array.isArray(value) ? value : [value];
  }

  if (problems.length > 0) throw new ConfigError(`${source}:\n  - ${problems.join("\n  - ")}`);

  const out: ResolvedConfig = {
    host: config.host,
    port: config.port,
    providers,
    aliases,
    usageLog: config.usageLog,
    source,
  };
  if (config.defaultProvider !== undefined) out.defaultProvider = config.defaultProvider;
  return out;
}

export function configSearchPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.MODELPLUG_CONFIG) paths.push(env.MODELPLUG_CONFIG);
  paths.push(join(process.cwd(), "modelplug.json"));
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  paths.push(join(xdg, "modelplug", "config.json"));
  return paths;
}

/** Single-provider mode from environment variables alone. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config | undefined {
  const preset = env.MODELPLUG_PRESET;
  const wire = env.MODELPLUG_WIRE;
  if (!preset && !wire) return undefined;
  const provider: ProviderConfigInput = {};
  if (preset) provider.preset = preset;
  if (wire) {
    if (!(WIRES as readonly string[]).includes(wire)) {
      throw new ConfigError(`MODELPLUG_WIRE must be one of ${WIRES.join(", ")}`);
    }
    provider.wire = wire as WireName;
  }
  if (env.MODELPLUG_BASE_URL) provider.baseUrl = env.MODELPLUG_BASE_URL;
  const key = env.MODELPLUG_API_KEY ?? (preset ? env[apiKeyEnvName(preset)] : undefined);
  if (key) provider.apiKey = key;
  const raw: Record<string, unknown> = { providers: { default: provider }, defaultProvider: "default" };
  if (env.MODELPLUG_PORT) raw.port = Number(env.MODELPLUG_PORT);
  if (env.MODELPLUG_HOST) raw.host = env.MODELPLUG_HOST;
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`environment config is invalid\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadConfig(explicitPath?: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const candidates = explicitPath ? [explicitPath] : configSearchPaths(env);
  for (const path of candidates) {
    if (!existsSync(path)) {
      if (explicitPath) throw new ConfigError(`config file not found: ${path}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new ConfigError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseConfig(interpolateEnv(raw, env), path);
  }
  const fromEnv = configFromEnv(env);
  if (fromEnv) return resolveConfig(fromEnv, "environment");
  const example = Object.entries(loadPresets()).find(([, p]) => (p.credential ?? "api-key") === "api-key")?.[0] ?? "<preset>";
  throw new ConfigError(
    `no config found. Looked for:\n  - ${candidates.join("\n  - ")}\n` +
      `or set MODELPLUG_PRESET (for example MODELPLUG_PRESET=${example} ${apiKeyEnvName(example)}=...).`,
  );
}

/** `<PRESET>_API_KEY`, the environment variable single-provider mode reads for a preset. */
export function apiKeyEnvName(preset: string): string {
  return `${preset.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function stripTrailingSlash(url: string | undefined): string | undefined {
  return url === undefined ? undefined : url.replace(/\/+$/, "");
}

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function stripUndefined<T extends object>(value: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Defined<T>;
}
