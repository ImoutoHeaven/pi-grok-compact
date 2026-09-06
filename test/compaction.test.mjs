import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SessionManager, buildSessionContext, convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { createGrokCompaction } from "../src/index.ts";
import { latestCheckpoint, MAX_BYTES, replay, validateOutput } from "../src/checkpoint.ts";
import { isGrok, requestCompaction, resolveRoute, routeIdentity } from "../src/remote.ts";

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
  const ctx = {
    model, sessionManager: manager, getSystemPrompt: () => "Keep the secret code.",
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-relay-key" }),
      getProvider: () => ({ stream }),
    },
    ui: { setStatus() {}, notify: (...args) => notifications.push(args) },
  };
  createGrokCompaction({ fetch })({ on: (event, handler) => handlers.set(event, handler) });
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
    assert.equal(valid.handlers.get("before_provider_request")({ payload: { input: [] } }, valid.ctx), undefined);
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
