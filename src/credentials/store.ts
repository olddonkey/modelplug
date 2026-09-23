/** `credentials.json`: the one file that holds tokens. Mode 0600, written atomically. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const accountSchema = z.strictObject({
  id: z.string().min(1),
  accountId: z.string().min(1),
  email: z.string().optional(),
  planType: z.string().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().optional(),
  lastRefresh: z.string(),
  source: z.enum(["import", "login"]),
  needsLogin: z.boolean().optional(),
});

const kimiAccountSchema = z.strictObject({
  id: z.string().min(1),
  email: z.string().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  lastRefresh: z.string(),
  source: z.literal("login"),
  needsLogin: z.boolean().optional(),
});

const storeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  chatgpt: z.strictObject({
    accounts: z.array(accountSchema),
    active: z.string().optional(),
  }),
  kimi: z.strictObject({
    accounts: z.array(kimiAccountSchema),
    deviceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  }).optional(),
});

export type ChatgptAccount = z.infer<typeof accountSchema>;
export type KimiAccount = z.infer<typeof kimiAccountSchema>;
export type CredentialStore = z.infer<typeof storeSchema>;

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export function emptyCredentialStore(): CredentialStore {
  return { schemaVersion: 1, chatgpt: { accounts: [] } };
}

export function defaultCredentialStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODELPLUG_CREDENTIALS) return env.MODELPLUG_CREDENTIALS;
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "modelplug", "credentials.json");
}

export function loadCredentialStore(path: string): CredentialStore {
  if (!existsSync(path)) return emptyCredentialStore();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CredentialStoreError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) throw new CredentialStoreError(`${path}: invalid credential store\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function saveCredentialStore(path: string, store: CredentialStore): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows has no POSIX modes */
  }
  renameSync(tmp, path);
}
