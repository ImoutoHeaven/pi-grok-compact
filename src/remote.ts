import type { Api, Context, Model, Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import { isObject, MAX_BYTES, validateOutput, type Item } from "./checkpoint.ts";

export function isGrok(model: Model<Api> | undefined): model is Model<Api> {
  return model?.id.startsWith("grok-") === true && model.api === "openai-responses";
}

export function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Grok endpoints require HTTPS (or loopback HTTP) and a URL without credentials or query parameters");
  }
  return url.href.replace(/\/+$/, "").replace(/\/responses$/, "");
}

export type CompactFailure = "auth" | "entitlement" | "quota" | "rate_limit" | "unsupported" | "transport" | "protocol";

export class GrokCompactionError extends Error {
  readonly kind: CompactFailure;
  readonly status?: number;
  constructor(message: string, kind: CompactFailure = "protocol", status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

function classifyFailure(status: number, body: unknown): CompactFailure {
  const nested = isObject(body) && isObject(body.error) ? body.error : body;
  const code = isObject(nested) && typeof nested.code === "string" ? nested.code.toLowerCase() : "";
  const message = isObject(nested) && typeof nested.message === "string" ? nested.message :
    isObject(body) && typeof body.error === "string" ? body.error : "";
  if (status === 401) return "auth";
  if (status === 402 || ["subscription:free-usage-exhausted", "insufficient_quota", "billing_quota_exceeded"].includes(code)) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 403 && (["entitlement_unavailable", "insufficient_entitlement", "compaction_entitlement_required"].includes(code) ||
      (["", "permission-denied", "permission_denied", "forbidden"].includes(code) &&
       /\bentitlement\b/i.test(message) && /\b(unavailable|missing|required|denied|insufficient)\b/i.test(message)))) return "entitlement";
  if ([400, 404, 405, 501].includes(status) && ["unsupported_endpoint", "unsupported_operation", "compaction_not_supported"].includes(code)) return "unsupported";
  return status >= 500 ? "transport" : "protocol";
}

export function routeIdentity(model: Model<Api>): string {
  return JSON.stringify([model.provider, model.api, model.id, baseUrl(model.baseUrl)]);
}

export async function capturePayload(options: {
  provider: Provider;
  model: Model<Api>;
  context: Context;
  auth: { apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> };
  signal: AbortSignal;
  sessionId: string;
}): Promise<Item & { input: unknown[] }> {
  let payload: unknown;
  let attemptedNetwork = false;
  const stop = new Error("Grok compaction serialization complete");
  const events = options.provider.stream(options.model, options.context, {
    ...options.auth, signal: options.signal, sessionId: options.sessionId,
    transport: "sse", maxRetries: 0,
    onPayload: value => { payload = structuredClone(value); throw stop; },
    fetch: async () => { attemptedNetwork = true; throw stop; },
  });
  for await (const _event of events) { /* The deliberate stop is consumed by Pi's stream adapter. */ }
  options.signal.throwIfAborted();
  if (attemptedNetwork || !isObject(payload) || payload.model !== options.model.id || !Array.isArray(payload.input)) {
    throw new Error("Grok provider did not expose a Responses payload before transport");
  }
  return payload as Item & { input: unknown[] };
}

export function resolveRoute(
  model: Model<Api>,
  auth: { apiKey?: string; headers?: ProviderHeaders },
): { url: string; headers: Headers } {
  const compact = baseUrl(model.baseUrl);
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
  for (const source of [model.headers, auth.headers]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(key);
      else headers.set(key, value);
    }
  }
  if (!headers.has("authorization")) throw new Error("Grok compaction credentials are unavailable");
  return { url: `${compact}/responses/compact`, headers };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("xAI returned an empty compaction response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("xAI compaction response exceeded 8 MiB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("xAI returned malformed compaction JSON"); }
}

export async function requestCompaction(options: {
  route: ReturnType<typeof resolveRoute>;
  model: string;
  input: unknown[];
  sessionId?: string;
  instructions?: string;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<{ output: Item[] }> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 300_000)]);
  signal.throwIfAborted();
  const response = await (options.fetch ?? globalThis.fetch)(options.route.url, {
    method: "POST", headers: options.route.headers, redirect: "error", signal,
    body: JSON.stringify({ model: options.model, input: options.input, prompt_cache_key: options.sessionId, instructions: options.instructions }),
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await readJson(response);
    } catch { /* HTTP status remains available for empty or malformed error bodies. */ }
    const kind = classifyFailure(response.status, body);
    const nested = isObject(body) && isObject(body.error) ? body.error : body;
    const reason = isObject(nested) && nested.code === "subscription:free-usage-exhausted" ? "Free usage exhausted; wait for quota recovery" :
      kind === "auth" ? "OAuth or API credentials were rejected; sign in again" :
      response.status === 402 ? "Subscription credits or spending limit exhausted" :
      kind === "entitlement" ? "Native compaction entitlement unavailable" :
      kind === "quota" ? "Provider quota exhausted" :
      kind === "rate_limit" ? "Rate limited; retry after the provider's cooldown" :
      kind === "unsupported" ? "The endpoint does not support native compaction" : "Native compaction request failed";
    throw new GrokCompactionError(`${reason} (HTTP ${response.status}); history retained.`, kind, response.status);
  }
  const data = await readJson(response);
  signal.throwIfAborted();
  if (!isObject(data) || data.object !== "response.compaction") throw new Error("xAI returned an unexpected compaction envelope");
  return { output: validateOutput(data.output) };
}
