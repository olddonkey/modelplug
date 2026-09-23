/** Credential kinds the config accepts. */
export const CREDENTIAL_KINDS = ["api-key", "chatgpt", "kimi", "grok"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Kinds whose provider speaks the client's own protocol natively; presets may override. */
export const PASSTHROUGH_BY_DEFAULT: ReadonlySet<CredentialKind> = new Set(["chatgpt"]);

/** How a pool picks an account for a new conversation. */
export const ACCOUNT_STRATEGIES = ["lowest-usage", "round-robin", "fill-first"] as const;
export type AccountStrategy = (typeof ACCOUNT_STRATEGIES)[number];
