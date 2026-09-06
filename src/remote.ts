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

export class GrokCompactionError extends Error {}

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
    let code: unknown;
    try {
      const error = await readJson(response);
      if (isObject(error)) code = isObject(error.error) ? error.error.code : error.code;
    } catch { /* HTTP status remains available for empty or malformed error bodies. */ }
    const reason = code === "subscription:free-usage-exhausted" ? "Free usage exhausted; wait for quota recovery" :
      response.status === 401 ? "OAuth or API credentials were rejected; sign in again" :
      response.status === 402 ? "Subscription credits or spending limit exhausted" :
      response.status === 403 ? "The account lacks access to native compaction" :
      response.status === 429 ? "Rate limited; retry after the provider's cooldown" : "Native compaction request failed";
    throw new GrokCompactionError(`${reason} (HTTP ${response.status}); history retained.`);
  }
  const data = await readJson(response);
  signal.throwIfAborted();
  if (!isObject(data) || data.object !== "response.compaction") throw new Error("xAI returned an unexpected compaction envelope");
  return { output: validateOutput(data.output) };
}
