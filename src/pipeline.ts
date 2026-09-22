/**
 * Joins ingress, route, credentials, attempts and wires into request handlers.
 *
 * Two paths share one attempt loop: the same-protocol passthrough for Responses
 * requests to an `openai-responses` provider (bytes relayed, headers injected,
 * no payload rewrites) and the IR path for every other wire (parse, encode,
 * decode, respond). Retries happen only before the first byte reaches the client.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_ATTEMPT_POLICY, RouteExhaustedError, runAttempts, type AttemptOutcome, type AttemptPolicy } from "./attempt.ts";
import type { ResolvedConfig, ResolvedProvider } from "./config.ts";
import { CredentialError, credentialProviderFor, type Credential, type CredentialDeps, type CredentialProvider } from "./credentials/index.ts";
import { IngressError, parseResponsesRequest, respondResponses, type ParsedResponses } from "./ingress/responses.ts";
import type { ErrorKind, Event, ProviderTarget, ResponseSink, Usage, WireError } from "./ir.ts";
import { forwardableHeaders, relayBody, relayableHeaders } from "./relay.ts";
import { RouteError, resolveRoute, type RouteTarget } from "./route.ts";
import { error as errorBody, sendJson, type BodyHandler, type Handlers } from "./server.ts";
import { appendUsage, defaultUsageLogPath, usageFromResponsesPayload } from "./usage.ts";
import { WIRES } from "./wire/index.ts";

export interface PipelineDeps extends CredentialDeps {
  /** `null` disables the usage log; undefined uses the default path when `config.usageLog` is on. */
  usageLogPath?: string | null;
  log?: (message: string) => void;
  attempt?: { policy?: AttemptPolicy; sleep?: (ms: number) => Promise<void> };
}

export interface Pipeline {
  handlers: Handlers;
  /** Human-readable account and quota lines for the `/` status page. */
  statusLines(): string[];
  /** The one credential provider per configured provider; probes reuse it so quota headers land on the status page. */
  credentialProvider(provider: ResolvedProvider): CredentialProvider;
}

const ERROR_STATUS: Record<ErrorKind, number> = {
  auth: 401,
  rate_limit: 429,
  quota: 429,
  overloaded: 503,
  invalid_request: 400,
  context_length: 400,
  not_found: 404,
  content_filter: 400,
  upstream: 502,
  network: 502,
  cancelled: 499,
};

const ERROR_TYPE: Record<ErrorKind, string> = {
  auth: "authentication_error",
  rate_limit: "rate_limit_error",
  quota: "rate_limit_error",
  overloaded: "server_error",
  invalid_request: "invalid_request_error",
  context_length: "invalid_request_error",
  not_found: "invalid_request_error",
  content_filter: "invalid_request_error",
  upstream: "server_error",
  network: "server_error",
  cancelled: "client_cancelled",
};

interface AttemptCommon {
  target: RouteTarget;
  credential: Credential;
  creds: CredentialProvider;
  attempt: number;
}
interface PassthroughValue extends AttemptCommon {
  kind: "passthrough";
  upstream: Response;
}
interface IrValue extends AttemptCommon {
  kind: "ir";
  upstream: Response;
  first: Event;
  iterator: AsyncIterator<Event>;
  parsed: ParsedResponses;
}
type AttemptValue = PassthroughValue | IrValue;

type Route = "responses" | "compact";

export function createPipeline(config: ResolvedConfig, deps: PipelineDeps = {}): Pipeline {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.error(message));
  const usagePath = deps.usageLogPath === undefined ? (config.usageLog ? defaultUsageLogPath() : null) : deps.usageLogPath;
  const policy = deps.attempt?.policy ?? DEFAULT_ATTEMPT_POLICY;

  const credentials = new Map<string, CredentialProvider>();
  const credentialsFor = (provider: ResolvedProvider): CredentialProvider => {
    let existing = credentials.get(provider.name);
    if (!existing) {
      existing = credentialProviderFor(provider, deps);
      credentials.set(provider.name, existing);
    }
    return existing;
  };

  const responsesHandler = (route: Route): BodyHandler => async (body, req, res) => {
    const started = now();
    if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, errorBody("invalid_request_error", "request body must be a JSON object"));
    const request = body as Record<string, unknown>;
    const modelRef = typeof request.model === "string" ? request.model.trim() : "";
    if (!modelRef) return sendJson(res, 400, errorBody("invalid_request_error", "model is required"));
    if (typeof request.previous_response_id === "string") {
      return sendJson(res, 400, errorBody("invalid_request_error", "previous_response_id is not supported: modelplug keeps no conversation state; send the full transcript with store: false"));
    }
    let targets: RouteTarget[];
    try {
      targets = resolveRoute(config, modelRef);
    } catch (err) {
      if (err instanceof RouteError) return sendJson(res, err.code === "unknown_provider" ? 404 : 400, errorBody("invalid_request_error", err.message));
      throw err;
    }
    const conversationId = typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined;
    const controller = new AbortController();
    // `res` closes when the connection dies early or when the response completes; `req` closes as
    // soon as its body has been read, which already happened before this handler ran.
    const onClose = (): void => {
      if (!res.writableFinished) controller.abort(new Error("client closed the connection"));
    };
    res.once("close", onClose);
    const clientHeaders = forwardableHeaders(req.headers);
    const suffix = route === "compact" ? "/responses/compact" : "/responses";
    const logUsage = (fields: { target: RouteTarget; credential: string; attempt: number; status: "ok" | "error"; kind?: string; httpStatus?: number; usage?: Usage }): void => {
      appendUsage(
        usagePath,
        {
          ts: new Date(now()).toISOString(),
          ingress: "responses",
          route,
          modelRef,
          provider: fields.target.provider,
          model: fields.target.model,
          credential: fields.credential,
          attempt: fields.attempt,
          status: fields.status,
          ...(fields.kind ? { kind: fields.kind } : {}),
          ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}),
          ...(fields.usage ? { usage: fields.usage } : {}),
          durationMs: now() - started,
        },
        log,
      );
    };

    let parsedIr: ParsedResponses | undefined;
    const attempt = async (target: RouteTarget, n: number): Promise<AttemptOutcome<AttemptValue>> => {
      const provider = config.providers[target.provider]!;
      const creds = credentialsFor(provider);
      let credential: Credential;
      try {
        credential = await creds.resolve(target, n, conversationId);
      } catch (err) {
        if (err instanceof CredentialError) return { ok: false, error: { kind: "auth", message: err.message, provider: provider.name, retryable: false } };
        throw err;
      }
      const providerTarget: ProviderTarget = {
        name: provider.name,
        baseUrl: credential.baseUrl ?? provider.baseUrl,
        headers: { ...provider.headers, ...(credential.headers ?? {}) },
      };
      if (credential.apiKey !== undefined) providerTarget.apiKey = credential.apiKey;
      const wire = WIRES[provider.wire];
      if (!wire) {
        return {
          ok: false,
          error: {
            kind: "invalid_request",
            message: `provider "${provider.name}" uses wire "${provider.wire}", which this build cannot serve yet (it arrives in a later milestone)`,
            provider: provider.name,
            retryable: false,
          },
        };
      }

      let upstreamUrl: string;
      let upstreamInit: RequestInit;
      const passthrough = provider.wire === "openai-responses";
      if (passthrough) {
        // Same-protocol passthrough: inject headers, relay bytes, read status and headers. No payload rewrites.
        const headers: Record<string, string> = { ...clientHeaders, "content-type": "application/json", ...providerTarget.headers };
        if (providerTarget.apiKey) headers.authorization = `Bearer ${providerTarget.apiKey}`;
        upstreamUrl = `${providerTarget.baseUrl}${suffix}`;
        upstreamInit = { method: "POST", headers, body: JSON.stringify({ ...request, model: target.model }), signal: controller.signal };
      } else {
        if (route === "compact") {
          return { ok: false, error: { kind: "invalid_request", message: "compaction for routed providers is not implemented yet", provider: provider.name, retryable: false } };
        }
        try {
          parsedIr ??= parseResponsesRequest(request);
        } catch (err) {
          if (err instanceof IngressError) return { ok: false, error: { kind: "invalid_request", message: err.message, provider: "modelplug", retryable: false, status: err.status } };
          throw err;
        }
        const wireRequest = wire.encode({ ...parsedIr.turn, model: target.model }, provider.capabilities, providerTarget, true);
        upstreamUrl = wireRequest.url;
        upstreamInit = { method: wireRequest.method, headers: wireRequest.headers, body: wireRequest.body, signal: controller.signal };
      }
      let upstream: Response;
      try {
        upstream = await doFetch(upstreamUrl, upstreamInit);
      } catch (err) {
        if (controller.signal.aborted) return { ok: false, error: { kind: "cancelled", message: "client closed the connection", provider: provider.name, retryable: false } };
        const error: WireError = { kind: "network", message: `${providerTarget.baseUrl}: ${err instanceof Error ? err.message : String(err)}`, provider: provider.name, retryable: true };
        await creds.report(target, credential, { outcome: "error", error, ...(conversationId ? { conversationId } : {}) });
        logUsage({ target, credential: credential.id, attempt: n, status: "error", kind: error.kind });
        return { ok: false, error };
      }
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        const error = wire.classifyError(upstream.status, upstream.headers, text, providerTarget);
        const advice = await creds.report(target, credential, { outcome: "error", error, headers: upstream.headers, ...(conversationId ? { conversationId } : {}) });
        logUsage({ target, credential: credential.id, attempt: n, status: "error", kind: error.kind, httpStatus: upstream.status });
        const adjusted: WireError = { ...error, retryable: error.retryable || advice?.retry === true };
        // A credential-driven retry (refreshed token, next account) goes straight back out.
        if (advice?.retry) adjusted.retryAfterMs = advice.retryAfterMs ?? 0;
        return { ok: false, error: adjusted };
      }
      if (passthrough) return { ok: true, value: { kind: "passthrough", upstream, target, credential, creds, attempt: n } };

      // IR path: peek the first event so a stream that opens with an error can still fail over.
      const iterator = wire.decode(upstream, provider.capabilities, providerTarget)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) {
        const error: WireError = { kind: "upstream", message: "empty upstream stream", provider: provider.name, retryable: true, status: upstream.status };
        await creds.report(target, credential, { outcome: "error", error, headers: upstream.headers, ...(conversationId ? { conversationId } : {}) });
        return { ok: false, error };
      }
      if (first.value.type === "error") {
        const error = first.value.error;
        const advice = await creds.report(target, credential, { outcome: "error", error, headers: upstream.headers, ...(conversationId ? { conversationId } : {}) });
        logUsage({ target, credential: credential.id, attempt: n, status: "error", kind: error.kind, httpStatus: upstream.status });
        const adjusted: WireError = { ...error, retryable: error.retryable || advice?.retry === true };
        if (advice?.retry) adjusted.retryAfterMs = advice.retryAfterMs ?? 0;
        return { ok: false, error: adjusted };
      }
      return { ok: true, value: { kind: "ir", upstream, first: first.value, iterator, parsed: parsedIr!, target, credential, creds, attempt: n } };
    };

    let value: AttemptValue;
    try {
      const result = await runAttempts(targets, attempt, policy, { signal: controller.signal, ...(deps.attempt?.sleep ? { sleep: deps.attempt.sleep } : {}) });
      value = result.value;
    } catch (err) {
      res.off("close", onClose);
      if (err instanceof RouteExhaustedError) {
        const e = err.clientError ?? { kind: "upstream" as const, message: err.message, provider: targets[0]?.provider ?? "?", retryable: false };
        if (e.retryAfterMs !== undefined) res.setHeader("retry-after", String(Math.ceil(e.retryAfterMs / 1000)));
        return sendJson(res, ERROR_STATUS[e.kind], {
          error: { message: `${e.provider}: ${e.message}`, type: ERROR_TYPE[e.kind], code: e.kind, ...(e.status ? { upstream_status: e.status } : {}) },
        });
      }
      if (controller.signal.aborted) {
        if (!res.headersSent) res.statusCode = 499;
        res.end();
        return;
      }
      throw err;
    }

    const { upstream, target, credential, creds, attempt: attemptNumber } = value;
    if (value.kind === "passthrough") {
      res.writeHead(upstream.status, relayableHeaders(upstream.headers));
      const probe = createUsageProbe(upstream.headers.get("content-type") ?? "");
      await relayBody(upstream, res, probe.observe);
      res.off("close", onClose);
      const usage = probe.result();
      await creds.report(target, credential, { outcome: "ok", headers: upstream.headers, ...(conversationId ? { conversationId } : {}) });
      logUsage({ target, credential: credential.id, attempt: attemptNumber, status: "ok", httpStatus: upstream.status, ...(usage ? { usage } : {}) });
      res.end();
      return;
    }

    // IR path: translate events back into the client's protocol.
    let usage: Usage | undefined;
    let terminal: Event["type"] | undefined;
    const { first, iterator } = value;
    const events = (async function* (): AsyncGenerator<Event> {
      const observe = (event: Event): Event => {
        if (event.type === "done") {
          terminal = "done";
          usage = event.usage;
        } else if (event.type === "error") terminal = "error";
        return event;
      };
      yield observe(first);
      if (first.type === "done" || first.type === "error") return;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield observe(next.value);
      }
    })();
    await respondResponses(events, value.parsed, nodeSink(res), { now, errorStatus: kind => ERROR_STATUS[kind] });
    res.off("close", onClose);
    await creds.report(target, credential, { outcome: "ok", headers: upstream.headers, ...(conversationId ? { conversationId } : {}) });
    logUsage({ target, credential: credential.id, attempt: attemptNumber, status: terminal === "error" ? "error" : "ok", httpStatus: upstream.status, ...(usage ? { usage } : {}) });
  };

  function statusLines(): string[] {
    const lines: string[] = [];
    for (const provider of Object.values(config.providers)) {
      const creds = credentialsFor(provider);
      if (!creds.status) continue;
      for (const line of creds.status()) lines.push(`${provider.name}  ${line}`);
    }
    return lines;
  }

  return {
    handlers: { responses: responsesHandler("responses"), compact: responsesHandler("compact") },
    statusLines,
    credentialProvider: credentialsFor,
  };
}

function nodeSink(res: ServerResponse): ResponseSink {
  res.on("error", () => {
    /* the client went away mid-write; nothing to add */
  });
  return {
    status(code, headers) {
      if (!res.headersSent) res.writeHead(code, headers);
    },
    write(chunk) {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

/**
 * Reads `usage` out of a relayed Responses stream or JSON body without
 * buffering the stream. The Codex backend sends SSE without a content-type, so
 * the mode is sniffed from the first bytes when the header is missing.
 */
export function createUsageProbe(contentType: string): { observe(chunk: Uint8Array): void; result(): Usage | undefined } {
  const decoder = new TextDecoder("utf-8");
  const JSON_CAP = 8 * 1024 * 1024;
  let mode: "sse" | "json" | undefined = contentType.includes("text/event-stream") ? "sse" : contentType.includes("json") ? "json" : undefined;
  let buffer = "";
  let json = "";
  let jsonBytes = 0;
  let usage: Usage | undefined;
  const scanLines = (): void => {
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:") || !line.includes('"response.completed"')) continue;
      try {
        const data = JSON.parse(line.slice(5).trim()) as { type?: string; response?: { usage?: unknown } };
        if (data.type === "response.completed") usage = usageFromResponsesPayload(data.response?.usage) ?? usage;
      } catch {
        /* partial or foreign line */
      }
    }
  };
  return {
    observe(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      if (mode === undefined) {
        const probe = (buffer + text).trimStart();
        if (probe.length === 0) {
          buffer += text;
          return;
        }
        mode = probe.startsWith("{") ? "json" : "sse";
        if (mode === "json") {
          json = buffer + text;
          jsonBytes = Buffer.byteLength(json);
          buffer = "";
          return;
        }
      }
      if (mode === "sse") {
        buffer += text;
        scanLines();
        return;
      }
      jsonBytes += chunk.length;
      if (jsonBytes <= JSON_CAP) json += text;
    },
    result() {
      if (mode === "sse") {
        buffer += decoder.decode();
        scanLines();
        return usage;
      }
      const tail = json + decoder.decode();
      if (tail.length > 0 && jsonBytes <= JSON_CAP) {
        try {
          const data = JSON.parse(tail) as { usage?: unknown };
          usage = usageFromResponsesPayload(data.usage) ?? usage;
        } catch {
          /* not JSON */
        }
      }
      return usage;
    },
  };
}
