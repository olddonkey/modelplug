/** Credential kinds the config accepts. */
export const CREDENTIAL_KINDS = ["api-key", "chatgpt"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
