import type { ResolvedProvider } from "../config.ts";
import type { Credential, CredentialProvider } from "./index.ts";

/** The trivial credential: the key from config, the same on every attempt. */
export function apiKeyCredentials(provider: ResolvedProvider): CredentialProvider {
  const credential: Credential = { id: "key" };
  if (provider.apiKey !== undefined) credential.apiKey = provider.apiKey;
  return {
    kind: "api-key",
    async resolve() {
      return credential;
    },
    async report() {
      /* nothing to learn from an API key */
    },
  };
}
