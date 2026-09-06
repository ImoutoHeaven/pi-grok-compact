import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SessionManager, buildSessionContext, convertToLlm, compact as piCompact,
} from "@earendil-works/pi-coding-agent";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { createGrokCompaction } from "../src/index.ts";
import { createCheckpoint, latestCheckpoint, MAX_BYTES, replay, summary as checkpointSummary, validateOutput } from "../src/checkpoint.ts";
import { isGrok, requestCompaction, resolveRoute, routeIdentity } from "../src/remote.ts";
import { createOAuthReplayRouter, oauthState, oauthCompactRoute } from "../src/oauth.ts";

// Pi 0.84.2's internal cut-point calculation supplies realistic compaction events.
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

const model = {
  id: "grok-4.6", name: "Grok", provider: "arbitrary-cliproxy-name", api: "openai-responses",
  baseUrl: "https://relay.example/v1", reasoning: true, input: ["text", "image"],
  contextWindow: 500000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 10000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 10100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
// Opaque fixture includes Unicode and extra fields to check lossless replay.
const opaque = [{ type: "compaction", id: "cmp_offline", encrypted_content: "opaque+/=\n原样", extension_field: { preserve: true } }];
const envelope = { object: "response.compaction", output: opaque };
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (text, content = [{ type: "text", text }]) => ({
  role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
  usage, stopReason: "stop", timestamp: Date.now(),
});

async function harness(t, fetch) {
  const directory = await mkdtemp(join(tmpdir(), "grok-compact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage(user("Remember code ORCHID-739. " + "Historical context. ".repeat(200)));
  manager.appendMessage(assistant("Recorded"));
  manager.appendMessage(user("Read the file"));
  manager.appendMessage(assistant("", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }]));
  manager.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant("Read complete"));
  const handlers = new Map();
  const notifications = [];
  let provider = { stream, streamSimple };
  let registered = {};
  const ctx = {
    model, sessionManager: manager, getSystemPrompt: () => "Keep the secret code.",
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-relay-key" }),
      getProvider: () => provider,
      isUsingOAuth: () => false,
      getRegisteredProviderConfig: () => registered,
    },
    ui: { setStatus() {}, notify: (...args) => notifications.push(args) },
  };
  createGrokCompaction({ fetch })({
    on: (event, handler) => handlers.set(event, handler),
    registerProvider: (_id, config) => {
      registered = { ...registered, ...config };
      provider = { stream: config.streamSimple, streamSimple: config.streamSimple };
    },
  });
  const compact = async (signal = new AbortController().signal) => {
    const entries = ctx.sessionManager.getBranch();
    const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 });
    assert.ok(preparation);
    return handlers.get("session_before_compact")({ type: "session_before_compact", preparation, branchEntries: entries, signal }, ctx);
  };
  const persist = result => {
    const c = result.compaction;
    ctx.sessionManager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
    ctx.sessionManager = SessionManager.open(ctx.sessionManager.getSessionFile());
  };
  return { ctx, handlers, compact, persist, notifications };
}

test("native compact -> actual Pi JSONL reopen -> Responses replay -> recompact", async t => {
  const compactInputs = [];
  const h = await harness(t, async (url, options) => {
    assert.equal(url, "https://relay.example/v1/responses/compact");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.get("authorization"), "Bearer test-relay-key");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ["input", "model", "prompt_cache_key"]);
    assert.equal(body.prompt_cache_key, h.ctx.sessionManager.getSessionId());
    assert.equal(body.model, model.id);
    assert.ok(!body.input.some(item => item.type === "compaction_trigger"));
    compactInputs.push(body.input);
    return Response.json(envelope);
  });
  const result = await h.compact();
  assert.ok(result.compaction);
  assert.ok(compactInputs[0].some(item => item.type === "function_call"));
  assert.ok(compactInputs[0].some(item => item.type === "function_call_output"));
  assert.ok(JSON.stringify(compactInputs[0]).includes("ORCHID-739"));
  h.persist(result);
  const restored = latestCheckpoint(h.ctx.sessionManager.getBranch());
  assert.equal(restored.version, 2);
  assert.equal(restored.authKind, "non-oauth");
  assert.deepEqual(restored.output, opaque);
  assert.equal(restored.route, routeIdentity(model));
  const disk = await readFile(h.ctx.sessionManager.getSessionFile(), "utf8");
  assert.ok(!disk.includes("test-relay-key"));

  h.ctx.sessionManager.appendMessage(user("What is the code?"));
  const context = buildSessionContext(h.ctx.sessionManager.getBranch());
  const projected = await h.handlers.get("context")({ messages: context.messages }, h.ctx);
  let sent;
  const responseStream = stream(model, {
    systemPrompt: h.ctx.getSystemPrompt(), messages: convertToLlm(projected.messages),
  }, {
    apiKey: "test-relay-key", maxRetries: 0,
    onPayload: payload => h.handlers.get("before_provider_request")({ payload }, h.ctx),
    fetch: async (url, options) => {
      assert.equal(String(url), "https://relay.example/v1/responses");
      sent = JSON.parse(options.body);
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":50,"output_tokens":0,"total_tokens":50}}}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  for await (const event of responseStream) assert.notEqual(event.type, "error");
  assert.deepEqual(sent.input[0], opaque[0]);
  assert.ok(JSON.stringify(sent.input).includes("What is the code?"));
  assert.ok(!JSON.stringify(sent.input).includes("ORCHID-739"));
  assert.ok(!JSON.stringify(sent.input).includes("file contents"));
  assert.ok(!JSON.stringify(sent.input).includes("PI_GROK_CHECKPOINT"));
  h.ctx.sessionManager.appendMessage(assistant("Offline answer"));
  const again = await h.compact();
  assert.ok(again.compaction);
  assert.deepEqual(compactInputs[1][0], opaque[0]);
  assert.ok(JSON.stringify(compactInputs[1]).includes("What is the code?"));
  assert.ok(!JSON.stringify(compactInputs[1]).includes("ORCHID-739"));
  h.persist(again);
  h.ctx.sessionManager.appendMessage(user("Continue after the second checkpoint"));
  const next = h.handlers.get("context")({ messages: buildSessionContext(h.ctx.sessionManager.getBranch()).messages }, h.ctx);
  assert.ok(next.messages.some(m => JSON.stringify(m).includes("Continue after the second checkpoint")));
});

test("failed, malformed and cancelled compactions retain the original session", async t => {
  for (const response of [
    () => new Response("secret-upstream-body", { status: 401 }),
    () => new Response("not JSON"),
    () => Response.json({ object: "response.compaction", output: [] }),
    () => { throw new Error("secret transport error"); },
  ]) {
    const h = await harness(t, async () => response());
    const before = JSON.stringify(h.ctx.sessionManager.getBranch());
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.equal(JSON.stringify(h.ctx.sessionManager.getBranch()), before);
    assert.ok(!JSON.stringify(h.notifications).includes("secret"));
  }
  const h = await harness(t, async () => { assert.fail("aborted compaction sent a request"); });
  assert.deepEqual(await h.compact(AbortSignal.abort()), { cancel: true });
});

test("session changes in flight discard the result, and other routes never receive the blob", async t => {
  let h;
  h = await harness(t, async () => {
    h.ctx.sessionManager.appendMessage(user("Concurrent turn"));
    return Response.json(envelope);
  });
  assert.deepEqual(await h.compact(), { cancel: true });

  const valid = await harness(t, async () => Response.json(envelope));
  valid.persist(await valid.compact());
  for (const changed of [{ ...model, id: "grok-other" }, { ...model, provider: "other" }, { ...model, baseUrl: "https://different.example/v1" }, { ...model, id: "gpt-6" }]) {
    valid.ctx.model = changed;
    assert.equal(valid.handlers.get("context")({ messages: buildSessionContext(valid.ctx.sessionManager.getBranch()).messages }, valid.ctx), undefined);
    const untouched = valid.handlers.get("before_provider_request")({ payload: { input: [] } }, valid.ctx);
    assert.equal(JSON.stringify(untouched ?? { input: [] }), '{"input":[]}');
  }
  valid.ctx.model = { ...model, provider: "other" };
  valid.ctx.sessionManager.appendMessage(user("A turn on the other route"));
  valid.ctx.sessionManager.appendMessage(assistant("New answer"));
  assert.deepEqual(await valid.compact(), { cancel: true });
});

test("Pi's actual extension loader accepts the standalone source", async () => {
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const path = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([path], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("session_before_compact"));
});

test("provider-neutral Grok selection and same-endpoint auth/header resolution", () => {
  assert.equal(isGrok(model), true);
  assert.equal(isGrok({ ...model, provider: "xai-oauth" }), true);
  assert.equal(isGrok({ ...model, id: "gpt-6" }), false);
  assert.equal(isGrok({ ...model, api: "openai-completions" }), false);
  const route = resolveRoute({ ...model, baseUrl: "http://127.0.0.1:8317/v1/responses/", headers: { "X-Remove": "old", "X-Custom": "keep" } }, {
    apiKey: "relay", headers: { authorization: "Bearer resolved", "X-Remove": null },
  });
  assert.equal(route.url, "http://127.0.0.1:8317/v1/responses/compact");
  assert.equal(route.headers.get("authorization"), "Bearer resolved");
  assert.equal(route.headers.get("x-custom"), "keep");
  assert.equal(route.headers.has("x-remove"), false);
  assert.throws(() => resolveRoute(model, {}));
  assert.throws(() => resolveRoute({ ...model, baseUrl: "https://user:secret@host/v1" }, {}));
});

test("strict output, marker and response size checks", async () => {
  assert.throws(() => validateOutput([{ type: "compaction", encrypted_content: "" }]));
  assert.throws(() => validateOutput([...opaque, ...opaque]));
  assert.throws(() => replay({ input: [] }, { checkpointId: "missing", output: opaque }));
  await assert.rejects(requestCompaction({
    model: model.id, route: resolveRoute(model, { apiKey: "test" }), input: [],
    signal: new AbortController().signal,
    fetch: async () => new Response("x".repeat(MAX_BYTES + 1)),
  }), /exceeded/);
});

function oauthToken(tier, sub = "test-account", refresh = 1) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ iss: "https://auth.x.ai", sub, team_id: "test-team", tier, refresh })}.fixture`;
}

function useOAuth(h, tier, baseUrl = "https://cli-chat-proxy.grok.com/v1", sub = "test-account", refresh = 1) {
  h.ctx.model = { ...model, provider: "third-party-oauth", baseUrl,
    headers: { "x-grok-client-version": "0.2.101", "x-xai-token-auth": "xai-grok-cli" } };
  const token = oauthToken(tier, sub, refresh);
  h.ctx.modelRegistry.isUsingOAuth = () => true;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token });
  return token;
}

function sseAnswer(text = "Summary from Pi") {
  const item = { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function inference(h, token, fetch, applyCheckpoint = true) {
  const context = buildSessionContext(h.ctx.sessionManager.getBranch());
  const projected = applyCheckpoint ? await h.handlers.get("context")({ messages: context.messages }, h.ctx) : undefined;
  const events = h.ctx.modelRegistry.getProvider().streamSimple(h.ctx.model, {
    systemPrompt: h.ctx.getSystemPrompt(), messages: convertToLlm(projected?.messages ?? context.messages),
  }, {
    apiKey: token, maxRetries: 0, fetch,
    onPayload: applyCheckpoint ? payload => h.handlers.get("before_provider_request")({ payload }, h.ctx) : undefined,
  });
  const errors = [];
  for await (const event of events) if (event.type === "error") errors.push(event.error.errorMessage);
  return errors;
}

test("direct OAuth paid compaction and restarted replay use official API with refreshed credentials", async t => {
  const compactCalls = [];
  const h = await harness(t, async (url, options) => {
    compactCalls.push({ url, options });
    assert.equal(url, "https://api.x.ai/v1/responses/compact");
    assert.equal(options.headers.has("x-grok-client-version"), false);
    return Response.json(envelope);
  });
  const initial = useOAuth(h, 1);
  h.persist(await h.compact());
  assert.equal(compactCalls[0].options.headers.get("authorization"), `Bearer ${initial}`);
  const stored = latestCheckpoint(h.ctx.sessionManager.getBranch());
  assert.match(stored.oauthAccount, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(initial));
  assert.ok(!JSON.stringify(stored).includes("test-account"));
  h.ctx.sessionManager.appendMessage(user("Continue using native history"));
  const refreshed = useOAuth(h, 1, undefined, undefined, 2);
  let replayCalls = 0;
  assert.deepEqual(await inference(h, refreshed, async (url, options) => {
    replayCalls++;
    assert.equal(url, "https://api.x.ai/v1/responses");
    assert.equal(options.headers.get("authorization"), `Bearer ${refreshed}`);
    assert.equal(options.headers.has("x-xai-token-auth"), false);
    assert.deepEqual(JSON.parse(options.body).input[0], opaque[0]);
    return sseAnswer("Continued");
  }), []);
  assert.equal(replayCalls, 1);
  h.ctx.sessionManager.appendMessage(assistant("Continued"));
  assert.ok((await h.compact()).compaction);
  assert.deepEqual(JSON.parse(compactCalls[1].options.body).input[0], opaque[0]);
});

test("free OAuth delegates to actual Pi prompt-summary and resumes through the CLI proxy", async t => {
  for (const tier of [0, 2, "Free", "X Basic"]) {
    const h = await harness(t, async () => assert.fail("free account called native compact"));
    const token = useOAuth(h, tier, "https://api.x.ai/v1");
    assert.equal(await h.compact(), undefined);
    const preparation = prepareCompaction(h.ctx.sessionManager.getBranch(), { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 });
    let summaries = 0;
    const result = await piCompact(preparation, h.ctx.model, token, undefined, undefined, new AbortController().signal, undefined,
      (m, context, options) => h.ctx.modelRegistry.getProvider().stream(m, context, {
        ...options, fetch: async (url, init) => {
          summaries++;
          assert.equal(url, "https://cli-chat-proxy.grok.com/v1/responses");
          assert.equal(init.headers.get("x-xai-token-auth"), "xai-grok-cli");
          assert.equal(init.headers.get("authorization"), `Bearer ${token}`);
          const body = JSON.parse(init.body);
          if (summaries === 1) assert.ok(JSON.stringify(body).includes("ORCHID-739"));
          assert.ok(!body.input.some(item => item.type === "compaction"));
          return sseAnswer();
        },
      }));
    assert.equal(summaries, preparation.isSplitTurn ? 2 : 1);
    assert.ok(result.summary.includes("Summary from Pi"));
    h.persist({ compaction: result });
    assert.equal(latestCheckpoint(h.ctx.sessionManager.getBranch()), undefined);
    h.ctx.sessionManager.appendMessage(user("Continue with the summary"));
    assert.deepEqual(await inference(h, token, async (url, init) => {
      assert.equal(url, "https://cli-chat-proxy.grok.com/v1/responses");
      assert.ok(JSON.stringify(JSON.parse(init.body).input).includes("Summary from Pi"));
      return sseAnswer("Continued");
    }), []);
  }
});

test("OAuth detection preserves relay routes and treats unknown tiers as unknown", () => {
  for (const tier of [undefined, null, "future-plan", 999, 0.5]) {
    const direct = { ...model, baseUrl: "https://api.x.ai/v1" };
    const auth = { apiKey: oauthToken(tier) };
    assert.equal(oauthState(direct, auth, true).tier, "unknown");
    assert.equal(oauthState(model, auth, true), undefined);
    assert.equal(oauthState(direct, auth, false), undefined);
  }
  const state = oauthState({ ...model, baseUrl: "https://cli-chat-proxy.grok.com/v1" }, { apiKey: "opaque-test-token" }, true);
  assert.equal(state.tier, "unknown");
  assert.equal(oauthCompactRoute(state).url, "https://api.x.ai/v1/responses/compact");
});

test("a changed OAuth account or a free downgrade cannot silently replay a paid checkpoint", async t => {
  const h = await harness(t, async () => Response.json(envelope));
  useOAuth(h, 1);
  h.persist(await h.compact());
  h.ctx.sessionManager.appendMessage(user("Resume"));
  for (const [tier, account] of [[1, "another-account"], [0, "test-account"]]) {
    const token = useOAuth(h, tier, undefined, account);
    const errors = await inference(h, token, async () => assert.fail("invalid account replay reached HTTP"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /original|paid account/);
    const before = JSON.stringify(h.ctx.sessionManager.getBranch());
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.equal(JSON.stringify(h.ctx.sessionManager.getBranch()), before);
  }
  h.ctx.modelRegistry.isUsingOAuth = () => false;
  const errors = await inference(h, "test-api-key", async () => assert.fail("OAuth checkpoint was sent with API-key auth"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /original OAuth login/);
  assert.deepEqual(await h.compact(), { cancel: true });
});

test("OAuth permission and quota failures stay distinct and sanitized", async t => {
  for (const [status, code, message] of [
    [401, "auth", /sign in again/], [403, "forbidden", /request failed/],
    [402, "billing", /spending limit/], [429, "subscription:free-usage-exhausted", /Free usage exhausted/],
  ]) {
    let calls = 0;
    const h = await harness(t, async () => { calls++; return Response.json({ error: { code, message: "private-upstream-text" } }, { status }); });
    useOAuth(h, 1);
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.equal(calls, 1);
    assert.match(h.notifications.at(-1)[0], message);
    assert.ok(!JSON.stringify(h.notifications).includes("private-upstream-text"));
  }
});

test("real Pi registry retains third-party OAuth login and refresh after stream wrapping", async t => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { ModelRegistry } = await import(new URL("./core/model-registry.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const directory = await mkdtemp(join(tmpdir(), "grok-oauth-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = oauthToken(1);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ "third-party-oauth": { type: "oauth", access: token, refresh: "test-refresh", expires: Date.now() + 3_600_000 } }));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: join(directory, "models.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const oauth = {
    name: "Test OAuth", isSubscription: true,
    login: async () => assert.fail("test must not log in"),
    refreshToken: async value => value,
    getApiKey: value => value.access,
  };
  let delegates = 0;
  const original = (m, context, options) => { delegates++; return streamSimple(m, context, options); };
  runtime.registerProvider("third-party-oauth", { api: "openai-responses", baseUrl: "https://cli-chat-proxy.grok.com/v1", models: [{ ...model, baseUrl: "https://cli-chat-proxy.grok.com/v1" }], oauth, streamSimple: original });
  await runtime.refresh({ allowNetwork: false });
  const activeModel = registry.find("third-party-oauth", model.id);
  assert.ok(activeModel);
  assert.equal(registry.isUsingOAuth(activeModel), true);
  let registrations = 0;
  const { install } = createOAuthReplayRouter({ registerProvider: (id, config) => { registrations++; registry.registerProvider(id, config); } });
  const ctx = { model: activeModel, modelRegistry: registry, sessionManager: { getBranch: () => [] } };
  install(ctx);
  await runtime.refresh({ allowNetwork: false });
  install(ctx);
  assert.equal(registrations, 1);
  assert.equal(registry.getRegisteredProviderConfig(activeModel.provider).oauth, oauth);
  assert.equal((await registry.getApiKeyAndHeaders(activeModel)).apiKey, token);
  const events = registry.getProvider(activeModel.provider).streamSimple(activeModel, { messages: [user("Normal OAuth turn")] }, {
    apiKey: token, maxRetries: 0,
    fetch: async url => { assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/responses"); return sseAnswer(); },
  });
  for await (const event of events) assert.notEqual(event.type, "error");
  assert.equal(delegates, 1);
  runtime.registerProvider(activeModel.provider, { api: "openai-responses", streamSimple: original });
  install(ctx);
  assert.equal(registrations, 2);
  assert.equal(registry.getRegisteredProviderConfig(activeModel.provider).oauth, oauth);
  await runtime.refresh({ allowNetwork: false });
});

test("unknown OAuth entitlement denial falls back and caches only the current credential and session", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const h = await harness(t, async () => {
    calls++;
    return Response.json({ error: { code: "entitlement_unavailable", message: "private error body" } }, { status: 403 });
  });
  useOAuth(h, undefined);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "opaque-credential-one" });
  assert.equal(await h.compact(), undefined);
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 1);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "opaque-credential-two" });
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 2);
  h.ctx.model = { ...h.ctx.model, id: "grok-4.5" };
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 3);
  h.ctx.model = { ...h.ctx.model, id: "grok-4.6" };
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 3);
  now += 5 * 60_000 + 1;
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 4);
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 5);
  const switched = SessionManager.inMemory();
  for (const entry of h.ctx.sessionManager.getBranch()) if (entry.type === "message") switched.appendMessage(entry.message);
  h.ctx.sessionManager = switched;
  assert.equal(await h.compact(), undefined);
  assert.equal(calls, 6);
  assert.ok(!JSON.stringify(h.notifications).includes("private error body"));
});

test("fallback requires explicit native capability denial, direct OAuth and no checkpoint", async t => {
  for (const [status, error, fallback] of [
    [403, { code: "entitlement_unavailable" }, true],
    [403, { message: "Native compaction entitlement unavailable" }, true],
    [404, { code: "unsupported_endpoint" }, true],
    [403, { code: "forbidden", message: "Access denied" }, false],
    [403, { code: "content_policy_violation", message: "Native compaction entitlement unavailable" }, false],
    [404, { code: "model_not_found" }, false],
    [401, { code: "entitlement_unavailable" }, false],
    [402, { code: "entitlement_unavailable" }, false],
    [429, { code: "rate_limit_exceeded" }, false],
    [500, { code: "internal_error" }, false],
  ]) {
    const h = await harness(t, async () => Response.json({ error }, { status }));
    useOAuth(h, undefined);
    assert.deepEqual(await h.compact(), fallback ? undefined : { cancel: true }, `${status}/${error.code ?? error.message}`);
  }
  const relay = await harness(t, async () => Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 }));
  relay.ctx.modelRegistry.isUsingOAuth = () => true;
  assert.deepEqual(await relay.compact(), { cancel: true });
  relay.ctx.model = { ...relay.ctx.model, baseUrl: "https://api.x.ai/v1" };
  relay.ctx.modelRegistry.isUsingOAuth = () => false;
  assert.deepEqual(await relay.compact(), { cancel: true });
  const malformed = await harness(t, async () => Response.json({ object: "response.compaction", output: [] }));
  useOAuth(malformed, undefined);
  assert.deepEqual(await malformed.compact(), { cancel: true });

  let denied = false;
  const prior = await harness(t, async () => denied
    ? Response.json({ error: { code: "entitlement_unavailable" } }, { status: 403 }) : Response.json(envelope));
  useOAuth(prior, undefined);
  prior.persist(await prior.compact());
  prior.ctx.sessionManager.appendMessage(user("Continue"));
  prior.ctx.sessionManager.appendMessage(assistant("Answer"));
  denied = true;
  const before = JSON.stringify(prior.ctx.sessionManager.getBranch());
  assert.deepEqual(await prior.compact(), { cancel: true });
  assert.equal(JSON.stringify(prior.ctx.sessionManager.getBranch()), before);
});

test("a capability rejection after a concurrent turn does not start fallback", async t => {
  let h;
  h = await harness(t, async () => {
    h.ctx.sessionManager.appendMessage(user("Concurrent turn"));
    return Response.json({ error: { code: "entitlement_unavailable" } }, { status: 403 });
  });
  useOAuth(h, undefined);
  assert.deepEqual(await h.compact(), { cancel: true });
});

test("OAuth provenance survives opaque tokens, missing subjects, restart and API-key switches", async t => {
  for (const credential of ["opaque-oauth-token", `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"tier":1}').toString('base64url')}.fixture`]) {
    const h = await harness(t, async () => Response.json(envelope));
    useOAuth(h, undefined);
    h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: credential });
    const result = await h.compact();
    assert.equal(result.compaction.details.version, 2);
    assert.equal(result.compaction.details.authKind, "oauth");
    assert.equal(result.compaction.details.oauthAccount, undefined);
    h.persist(result);
    h.ctx.sessionManager.appendMessage(user("Resume"));
    assert.deepEqual(await inference(h, credential, async () => sseAnswer()), []);
    assert.match(JSON.stringify(h.notifications), /account identity|account consistency/);
    assert.deepEqual(await inference(h, credential, async () => sseAnswer()), []);
    assert.equal(h.notifications.filter(([text]) => text.includes("account consistency")).length, 1);
    h.ctx.modelRegistry.isUsingOAuth = () => false;
    h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "new-api-key" });
    const errors = await inference(h, "new-api-key", async () => assert.fail("OAuth blob escaped to API-key transport"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /OAuth login/);
    assert.deepEqual(await h.compact(), { cancel: true });
  }
});

test("checkpoint provenance follows Pi authentication even on a custom OAuth gateway", async t => {
  const h = await harness(t, async () => Response.json(envelope));
  h.ctx.modelRegistry.isUsingOAuth = () => true;
  const result = await h.compact();
  assert.equal(result.compaction.details.authKind, "oauth");
  h.persist(result);
  h.ctx.sessionManager.appendMessage(user("Resume"));
  h.ctx.modelRegistry.isUsingOAuth = () => false;
  const errors = await inference(h, "new-api-key", async () => assert.fail("gateway OAuth blob escaped"));
  assert.equal(errors.length, 1);
  assert.deepEqual(await h.compact(), { cancel: true });
});

test("v1 OAuth fingerprints support replay; unknown v1 provenance blocks automatic reuse", async t => {
  for (const [known, direct] of [[true, true], [false, true], [false, false]]) {
    const h = await harness(t, async () => Response.json(envelope));
    const credential = direct ? useOAuth(h, 1) : "test-relay-key";
    const result = await h.compact();
    result.compaction.details.version = 1;
    delete result.compaction.details.authKind;
    if (!known) delete result.compaction.details.oauthAccount;
    h.persist(result);
    h.ctx.sessionManager.appendMessage(user("Resume v1 checkpoint"));
    const errors = await inference(h, credential, async () => {
      assert.ok(known, "v1 checkpoint with unknown provenance reached HTTP");
      return sseAnswer();
    });
    assert.equal(errors.length, known ? 0 : 1);
    if (!known) {
      assert.match(errors[0], /v1/);
      assert.deepEqual(await h.compact(), { cancel: true });
    }
  }
});

test("v2 parsing requires explicit, consistent authentication provenance", async t => {
  const h = await harness(t, async () => Response.json(envelope));
  const result = await h.compact();
  const details = result.compaction.details;
  for (const patch of [
    { authKind: undefined }, { authKind: "unknown" }, { version: 3 },
    { authKind: "non-oauth", oauthAccount: "a".repeat(64) },
    { version: 1, authKind: "non-oauth" },
  ]) {
    assert.throws(() => latestCheckpoint([{ type: "compaction", details: { ...details, ...patch } }]), /metadata is invalid/);
  }
});

test("real Pi runner invalidation preserves OAuth replay across reload, fork and resume", async t => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { ModelRegistry } = await import(new URL("./core/model-registry.js", entry));
  const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", entry));
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", entry));
  const directory = await mkdtemp(join(tmpdir(), "grok-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = oauthToken(1);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ "test-oauth": { type: "oauth", access: token, refresh: "test-refresh", expires: Date.now() + 3_600_000 } }));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: join(directory, "models.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  runtime.registerProvider("test-oauth", {
    api: "openai-responses", baseUrl: "https://cli-chat-proxy.grok.com/v1", models: [{ ...model, baseUrl: "https://cli-chat-proxy.grok.com/v1" }],
    oauth: { name: "Test OAuth", login: async () => assert.fail("unexpected login"), refreshToken: async value => value, getApiKey: value => value.access },
    streamSimple,
  });
  await runtime.refresh({ allowNetwork: false });
  const activeModel = registry.find("test-oauth", model.id);
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("Before compaction"));
  const retained = assistant("Retained");
  const kept = manager.appendMessage(retained);
  const details = createCheckpoint(routeIdentity(activeModel), opaque, [retained], "oauth", oauthState(activeModel, { apiKey: token }, true).account);
  manager.appendCompaction(checkpointSummary(details.checkpointId), kept, 10000, details, true);
  manager.appendMessage(user("Resume from the checkpoint"));
  let sent = 0;
  for (const reason of ["reload", "fork", "resume", "quit"]) {
    const loaded = await loadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], directory);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.registerProvider = (id, config) => registry.registerProvider(id, config);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, manager, registry);
    runner.getModel = () => activeModel;
    await runner.emit({ type: "session_start", reason: "startup" });
    const ctx = runner.createContext();
    const messages = await runner.emitContext(buildSessionContext(manager.getBranch()).messages);
    const events = registry.getProvider(activeModel.provider).streamSimple(activeModel, { messages: convertToLlm(messages) }, {
      apiKey: token, maxRetries: 0, onPayload: payload => runner.emitBeforeProviderRequest(payload),
      fetch: async (url, init) => {
        assert.equal(String(url), "https://api.x.ai/v1/responses");
        assert.deepEqual(JSON.parse(init.body).input[0], opaque[0]);
        assert.ok(!init.body.includes(details.oauthAccount));
        sent++;
        return sseAnswer();
      },
    });
    const errors = [];
    for await (const event of events) if (event.type === "error") errors.push(event.error.errorMessage);
    assert.deepEqual(errors, [], reason);
    if (reason !== "fork") {
      const wrapped = registry.getRegisteredProviderConfig(activeModel.provider).streamSimple;
      await runner.emit({ type: "session_shutdown", reason });
      assert.notEqual(registry.getRegisteredProviderConfig(activeModel.provider).streamSimple, wrapped);
    }
    runner.invalidate();
    assert.throws(() => ctx.modelRegistry, /extension ctx is stale/);
  }
  assert.equal(sent, 4);
  await runtime.refresh({ allowNetwork: false });
});
