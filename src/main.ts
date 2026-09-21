import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, loadPresets, type ResolvedConfig } from "./config.ts";
import { defaultCodexAuthPath, importCodexAuth, tokenExpiresAt } from "./credentials/chatgpt.ts";
import { CredentialError } from "./credentials/index.ts";
import { CredentialStoreError, defaultCredentialStorePath, loadCredentialStore, saveCredentialStore } from "./credentials/store.ts";
import { createPipeline } from "./pipeline.ts";
import { createRecorder, forwardHandler, withRecording } from "./record.ts";
import { RouteError, resolveRoute } from "./route.ts";
import { createServer, notImplementedHandler, ROUTE_PATHS, type Handlers } from "./server.ts";
import { defaultUsageLogPath } from "./usage.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const USAGE = `modelplug ${VERSION}

Usage:
  modelplug [start] [--config <file>] [--port <n>]   run the proxy (default)
      --record <dir>                                 save every request and response as fixtures
      --forward <baseUrl> [--forward-header k=v]...  relay raw requests to a real upstream
                                                     (key from MODELPLUG_FORWARD_KEY)
      --forward-model <name>                         rename the model in forwarded bodies
  modelplug check   [--config <file>]                validate config, show providers and aliases
  modelplug models  [--config <file>]                list provider/model ids and aliases
  modelplug print codex|claude [--model <ref>]       print the client-side snippet to paste
  modelplug presets                                  list built-in presets
  modelplug login chatgpt --import [--from <auth.json>]
                                                      reuse the login Codex already has (read-only)
  modelplug logout chatgpt                           forget every ChatGPT account
  modelplug account list|use <id>|remove <id>        manage ChatGPT accounts

Config is read from --config, $MODELPLUG_CONFIG, ./modelplug.json, or
~/.config/modelplug/config.json. With no file, MODELPLUG_PRESET (plus
<PRESET>_API_KEY) or MODELPLUG_WIRE + MODELPLUG_BASE_URL configures one provider.
`;

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      record: { type: "string" },
      forward: { type: "string" },
      "forward-header": { type: "string", multiple: true },
      "forward-model": { type: "string" },
      import: { type: "boolean" },
      from: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return console.log(VERSION);
  if (values.help) return console.log(USAGE);

  const command = positionals[0] ?? "start";
  try {
    switch (command) {
      case "start":
        return await start(loadConfig(values.config), values.port, {
          record: values.record,
          forward: values.forward,
          forwardHeaders: values["forward-header"] ?? [],
          forwardModel: values["forward-model"],
        });
      case "check":
        return check(loadConfig(values.config));
      case "models":
        return models(loadConfig(values.config));
      case "print":
        return print(positionals[1], values.model, values.config);
      case "presets":
        return presets();
      case "login":
        return login(positionals[1], values.import === true, values.from);
      case "logout":
        return logout(positionals[1]);
      case "account":
        return account(positionals[1], positionals[2]);
      default:
        console.error(`unknown command "${command}"\n`);
        console.error(USAGE);
        process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RouteError || err instanceof CredentialError || err instanceof CredentialStoreError) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

interface StartOptions {
  record?: string | undefined;
  forward?: string | undefined;
  forwardHeaders: string[];
  forwardModel?: string | undefined;
}

async function start(config: ResolvedConfig, portFlag: string | undefined, options: StartOptions): Promise<void> {
  const port = portFlag ? Number(portFlag) : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`invalid port "${portFlag}"`);

  let handlers: Handlers = {};
  if (options.forward) {
    if (!/^https?:\/\//.test(options.forward)) throw new ConfigError("--forward needs an http(s) base URL that contains `responses`, e.g. https://api.openai.com/v1");
    const extra: Record<string, string> = {};
    for (const pair of options.forwardHeaders) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new ConfigError(`--forward-header expects k=v, got "${pair}"`);
      extra[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const forward = forwardHandler({
      baseUrl: options.forward,
      ...(process.env.MODELPLUG_FORWARD_KEY ? { apiKey: process.env.MODELPLUG_FORWARD_KEY } : {}),
      headers: extra,
      ...(options.forwardModel ? { model: options.forwardModel } : {}),
    });
    handlers = { responses: forward, compact: forward, messages: forward };
  }
  let statusLines: (() => string[]) | undefined;
  if (!options.forward) {
    const pipeline = createPipeline(config, { log: console.error });
    handlers = { ...pipeline.handlers, ...handlers };
    statusLines = pipeline.statusLines;
  }
  if (options.record) {
    const recorder = createRecorder(options.record);
    for (const route of Object.keys(ROUTE_PATHS) as Array<keyof Handlers>) {
      handlers[route] = withRecording(recorder, route, handlers[route] ?? notImplementedHandler(ROUTE_PATHS[route]));
    }
  }
  const server = createServer(config, handlers, VERSION, statusLines ? { statusLines } : {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => resolve());
  });
  console.log(`modelplug ${VERSION} listening on http://${config.host}:${port}  (config: ${config.source})`);
  console.log(`providers: ${Object.keys(config.providers).join(", ") || "none"}`);
  if (options.forward) console.log(`forwarding /v1/* raw to ${options.forward}${process.env.MODELPLUG_FORWARD_KEY ? " with MODELPLUG_FORWARD_KEY" : " (no key)"}`);
  if (options.record) console.log(`recording requests and responses under ${options.record}`);
  if (!options.forward) {
    console.log(`usage log: ${config.usageLog ? defaultUsageLogPath() : "off"}`);
    const chatgpt = Object.values(config.providers).filter(p => p.credential === "chatgpt").map(p => p.name);
    if (chatgpt.length > 0) console.log(`chatgpt passthrough: ${chatgpt.join(", ")}  (accounts and quota: http://${config.host}:${port}/)`);
    const missing = Object.values(config.providers).filter(p => p.wire !== "openai-responses" && p.wire !== "openai-chat").map(p => `${p.name} (${p.wire})`);
    if (missing.length > 0) console.log(`not served yet in this build: ${missing.join(", ")}`);
    console.log("note: /v1/messages answers 501 until the messages ingress lands.");
  }
  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function check(config: ResolvedConfig): void {
  console.log(`config: ${config.source}`);
  console.log(`listen: ${config.host}:${config.port}\n`);
  console.log("providers:");
  for (const p of Object.values(config.providers)) {
    const caps = p.capabilities;
    const capsText = [
      `reasoning=${caps.reasoning}`,
      caps.tools ? "tools" : "no-tools",
      caps.images ? "images" : "no-images",
      caps.temperature ? "temperature" : "no-temperature",
      caps.stream,
    ].join(" ");
    console.log(`  ${p.name.padEnd(14)} ${p.wire.padEnd(17)} ${p.baseUrl}`);
    const cred = p.credential === "chatgpt" ? `chatgpt accounts=${chatgptAccountCount()}` : `api-key key=${p.apiKey ? "set" : "none"}`;
    console.log(`  ${"".padEnd(14)} ${cred}${p.preset ? ` preset=${p.preset}` : ""} ${capsText}`);
  }
  let failed = false;
  if (Object.keys(config.aliases).length > 0) {
    console.log("\naliases:");
    for (const alias of Object.keys(config.aliases)) {
      try {
        const targets = resolveRoute(config, alias);
        console.log(`  ${alias.padEnd(14)} -> ${targets.map(t => `${t.provider}/${t.model}`).join("  then  ")}`);
      } catch (err) {
        failed = true;
        console.log(`  ${alias.padEnd(14)} !! ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(failed ? "\ncheck failed" : "\nok (network probes arrive with the wire modules)");
  if (failed) process.exitCode = 1;
}

function models(config: ResolvedConfig): void {
  for (const p of Object.values(config.providers)) for (const m of p.models) console.log(`${p.name}/${m}`);
  for (const alias of Object.keys(config.aliases)) console.log(alias);
}

function print(client: string | undefined, model: string | undefined, configPath: string | undefined): void {
  let base = "http://127.0.0.1:10100";
  try {
    const config = loadConfig(configPath);
    base = `http://${config.host}:${config.port}`;
  } catch {
    // No config yet is fine for printing a snippet.
  }
  const ref = model ?? "<provider/model>";
  switch (client) {
    case "codex":
      console.log(`# Add to ~/.codex/config.toml (root keys first, then the table)
model_provider = "modelplug"
model = "${ref}"

[model_providers.modelplug]
name = "modelplug"
base_url = "${base}/v1"
wire_api = "responses"
`);
      return;
    case "claude":
      console.log(`# Export before running \`claude\`
export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="modelplug"
export ANTHROPIC_MODEL="${ref}"
# Optional: route the small/fast model too
# export ANTHROPIC_SMALL_FAST_MODEL="${ref}"
`);
      return;
    default:
      throw new ConfigError(`print needs a client: codex or claude`);
  }
}

function chatgptAccountCount(): string {
  try {
    return String(loadCredentialStore(defaultCredentialStorePath()).chatgpt.accounts.length);
  } catch (err) {
    return `? (${err instanceof Error ? err.message : String(err)})`;
  }
}

const POLICY_NOTE = `Provider policy: using ChatGPT accounts through modelplug is for convenience only. It gives no
protection from provider rate limits, enforcement, or account actions, and you are responsible
for complying with OpenAI's terms.`;

function login(provider: string | undefined, doImport: boolean, from: string | undefined): void {
  if (provider !== "chatgpt") throw new ConfigError("login supports one provider today: chatgpt");
  if (!doImport) {
    console.error("Browser login arrives with the account pool milestone. Today:\n  modelplug login chatgpt --import   (reuses the login Codex already has, read-only)");
    process.exitCode = 2;
    return;
  }
  const authPath = from ?? defaultCodexAuthPath();
  const account = importCodexAuth(authPath);
  const storePath = defaultCredentialStorePath();
  const store = loadCredentialStore(storePath);
  const index = store.chatgpt.accounts.findIndex(a => a.id === account.id);
  if (index >= 0) store.chatgpt.accounts[index] = account;
  else store.chatgpt.accounts.push(account);
  if (store.chatgpt.accounts.length === 1) store.chatgpt.active = account.id;
  saveCredentialStore(storePath, store);
  const expires = tokenExpiresAt(account.accessToken);
  console.log(`imported ${account.email ?? account.id}${account.planType ? ` (${account.planType})` : ""} from ${authPath}`);
  console.log(`stored in ${storePath} (mode 0600)${expires ? `; access token expires ${new Date(expires).toISOString()}, refreshed automatically` : ""}`);
  console.log(`\nNext: put this in your config and start the proxy\n  { "providers": { "chatgpt": { "preset": "chatgpt" } }, "defaultProvider": "chatgpt" }\nor simply:  MODELPLUG_PRESET=chatgpt modelplug\nthen:       modelplug print codex --model gpt-5.5\n\n${POLICY_NOTE}`);
}

function logout(provider: string | undefined): void {
  if (provider !== "chatgpt") throw new ConfigError("logout supports one provider today: chatgpt");
  const storePath = defaultCredentialStorePath();
  const store = loadCredentialStore(storePath);
  const count = store.chatgpt.accounts.length;
  store.chatgpt.accounts = [];
  delete store.chatgpt.active;
  saveCredentialStore(storePath, store);
  console.log(`removed ${count} ChatGPT account(s) from ${storePath}`);
}

function account(sub: string | undefined, id: string | undefined): void {
  const storePath = defaultCredentialStorePath();
  const store = loadCredentialStore(storePath);
  switch (sub) {
    case undefined:
    case "list": {
      if (store.chatgpt.accounts.length === 0) {
        console.log("no ChatGPT accounts. Run: modelplug login chatgpt --import");
        return;
      }
      for (const a of store.chatgpt.accounts) {
        const expires = tokenExpiresAt(a.accessToken);
        const marks = [a.id === store.chatgpt.active ? "active" : "", a.needsLogin ? "NEEDS LOGIN" : ""].filter(Boolean).join(", ");
        console.log(`${a.id}  ${a.email ?? "-"}  ${a.planType ?? "-"}  ${a.source}  token ${expires ? (expires < Date.now() ? "expired" : `valid until ${new Date(expires).toISOString()}`) : "no expiry"}${marks ? `  [${marks}]` : ""}`);
      }
      console.log("\nquota is shown on the proxy's status page while it runs (http://127.0.0.1:<port>/)");
      return;
    }
    case "use": {
      if (!id || !store.chatgpt.accounts.some(a => a.id === id)) throw new ConfigError(`account use needs an id from \`modelplug account list\``);
      store.chatgpt.active = id;
      saveCredentialStore(storePath, store);
      console.log(`active account: ${id}`);
      return;
    }
    case "remove": {
      const before = store.chatgpt.accounts.length;
      store.chatgpt.accounts = store.chatgpt.accounts.filter(a => a.id !== id);
      if (store.chatgpt.accounts.length === before) throw new ConfigError(`no account with id "${id}"`);
      if (store.chatgpt.active === id) delete store.chatgpt.active;
      saveCredentialStore(storePath, store);
      console.log(`removed ${id}`);
      return;
    }
    default:
      throw new ConfigError("account needs: list | use <id> | remove <id>");
  }
}

function presets(): void {
  for (const [name, p] of Object.entries(loadPresets())) {
    console.log(`${name.padEnd(12)} ${p.wire.padEnd(17)} ${p.baseUrl ?? "(baseUrl required)"}  reasoning=${p.capabilities.reasoning}`);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href || process.argv[1]?.endsWith("/src/main.ts")) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
