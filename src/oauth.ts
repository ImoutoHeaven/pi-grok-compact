import { createHash } from "node:crypto";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { checkpointAuthKind, isObject, latestCheckpoint, type Checkpoint } from "./checkpoint.ts";
import { baseUrl, GrokCompactionError, isGrok, resolveRoute, routeIdentity } from "./remote.ts";

const XAI_API = "https://api.x.ai/v1";
const XAI_CLI = "https://cli-chat-proxy.grok.com/v1";
type Auth = { apiKey?: string; headers?: ProviderHeaders };
type OAuthState = { tier: "free" | "paid" | "unknown"; account?: string; authorization: string };

export function isDirectOAuth(model: Model<Api> | undefined, usingOAuth: boolean): model is Model<Api> {
  return usingOAuth && isGrok(model) && [XAI_API, XAI_CLI].includes(baseUrl(model.baseUrl));
}

export function oauthState(model: Model<Api>, auth: Auth, usingOAuth: boolean): OAuthState | undefined {
  if (!isDirectOAuth(model, usingOAuth)) return;
  const authorization = resolveRoute(model, auth).headers.get("authorization") ?? "";
  const token = /^Bearer (.+)$/i.exec(authorization)?.[1];
  let claims: Record<string, unknown> = {};
  if (token && token.length <= 32_768) {
    try {
      const parts = token.split(".");
      const parsed: unknown = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : undefined;
      if (isObject(parsed)) claims = parsed;
    } catch { /* Opaque credentials have an unknown tier. */ }
  }
  // Resolved JWT claims guide routing; xAI remains the authority on token permissions.
  const tier = typeof claims.tier === "string" || typeof claims.tier === "number"
    ? String(claims.tier).trim().toLowerCase().replace(/[\s_-]/g, "") : "";
  const free = ["0", "2", "free", "grokfree", "freetier", "grokbasic", "xbasic", "basic"].includes(tier);
  const paid = ["1", "3", "4", "5", "6", "7", "supergrok", "grokpro", "supergrokheavy", "supergroklite", "supergrokplus", "supergrokpro", "xpremium", "xpremiumplus", "xpremium+"].includes(tier);
  const account = typeof claims.sub === "string" && claims.sub
    ? createHash("sha256").update(JSON.stringify([claims.iss ?? "", claims.sub, claims.team_id ?? claims.teamId ?? ""])).digest("hex") : undefined;
  return { tier: free ? "free" : paid ? "paid" : "unknown", account, authorization };
}

function apiHeaders(authorization: string, accept: string): Headers {
  return new Headers({ authorization, "content-type": "application/json", accept });
}

function freeHeaders(request: Request, model: Model<Api>): Headers {
  const headers = apiHeaders(request.headers.get("authorization") ?? "", request.headers.get("accept") ?? "text/event-stream");
  // ponytail: CLI version defaults to 0.2.101; use PI_XAI_CLIENT_VERSION when the proxy's version gate changes.
  const version = request.headers.get("x-grok-client-version") || process.env.PI_XAI_CLIENT_VERSION || "0.2.101";
  headers.set("user-agent", request.headers.get("x-grok-client-version") ? request.headers.get("user-agent") || `grok-shell/${version}` : `grok-shell/${version}`);
  headers.set("x-grok-client-identifier", request.headers.get("x-grok-client-identifier") || "grok-shell");
  headers.set("x-grok-client-version", version);
  headers.set("x-grok-client-mode", "interactive");
  headers.set("x-xai-token-auth", "xai-grok-cli");
  headers.set("x-authenticateresponse", "authenticate-response");
  headers.set("x-grok-model-override", model.id);
  return headers;
}

export function oauthCompactRoute(state: OAuthState): ReturnType<typeof resolveRoute> {
  return { url: `${XAI_API}/responses/compact`, headers: apiHeaders(state.authorization, "application/json") };
}

export function capabilityKey(model: Model<Api>, state: OAuthState): string {
  return `${routeIdentity(model)}:${createHash("sha256").update(state.authorization).digest("hex")}`;
}

export function assertCheckpointAuth(checkpoint: Checkpoint, usingOAuth: boolean, state?: OAuthState): void {
  const kind = checkpointAuthKind(checkpoint);
  if (kind === "unknown") {
    throw new GrokCompactionError("This v1 checkpoint has unknown authentication. Use Pi /tree to select a pre-compaction node and create a v2 checkpoint; keep the session file.");
  }
  if (kind === "oauth" && !usingOAuth) {
    throw new GrokCompactionError("This native checkpoint requires its original OAuth login; restore that login before replaying or compacting.");
  }
  if (state?.tier === "free") {
    throw new GrokCompactionError("This native checkpoint requires a paid account. Restore the original paid account; Free/X Basic sessions use Pi prompt-summary.");
  }
  if (checkpoint.oauthAccount && checkpoint.oauthAccount !== state?.account) {
    throw new GrokCompactionError("This native checkpoint belongs to a different OAuth account. Restore its original login before replaying.");
  }
}

type Stream = NonNullable<ProviderConfig["streamSimple"]>;
const ORIGINAL_STREAM = Symbol.for("pi-grok-compaction.original-stream");
const REQUEST_POLICY = Symbol.for("pi-grok-compaction.request-policy");
type WrappedStream = Stream & { [ORIGINAL_STREAM]?: Stream };
type RequestPolicy = { usingOAuth: boolean; checkpoint?: Checkpoint };

export function createOAuthReplayRouter(pi: ExtensionAPI) {
  const installed = new Map<string, { stream: Stream; original: Stream; registry: ExtensionContext["modelRegistry"] }>();
  let warningSession: string | undefined;
  const warned = new Set<string>();
  const prepare = (payload: unknown, ctx: ExtensionContext, checkpoint?: Checkpoint) => {
    if (!isObject(payload)) throw new GrokCompactionError("Grok replay requires a Responses payload");
    const model = ctx.model;
    if (!isGrok(model)) return payload;
    const usingOAuth = ctx.modelRegistry.isUsingOAuth(model);
    if (checkpoint && checkpointAuthKind(checkpoint) === "oauth" && !checkpoint.oauthAccount && usingOAuth) {
      const session = ctx.sessionManager.getSessionId();
      if (warningSession !== session) { warned.clear(); warningSession = session; }
      if (!warned.has(checkpoint.checkpointId)) {
        ctx.ui.notify("OAuth checkpoint has no stable account identity. Keep using the original account; account consistency cannot be verified.", "warning");
        warned.add(checkpoint.checkpointId);
      }
    }
    // Symbols survive object spreads and stay out of the serialized HTTP body.
    return { ...payload, [REQUEST_POLICY]: { usingOAuth, checkpoint } satisfies RequestPolicy };
  };
  const install = (ctx: ExtensionContext) => {
    const model = ctx.model;
    if (!isGrok(model)) return;
    const registry = ctx.modelRegistry;
    const active = latestCheckpoint(ctx.sessionManager.getBranch());
    const needsGuard = active && active.route === routeIdentity(model) && checkpointAuthKind(active) !== "non-oauth";
    if (!isDirectOAuth(model, registry.isUsingOAuth(model)) && !needsGuard) return;
    const config = registry.getRegisteredProviderConfig(model.provider);
    if (config?.streamSimple && config.streamSimple === installed.get(model.provider)?.stream) return;
    const provider = registry.getProvider(model.provider);
    if (!provider) return;
    const original = (config?.streamSimple as WrappedStream | undefined)?.[ORIGINAL_STREAM] ?? provider.streamSimple.bind(provider);
    const streamSimple: WrappedStream = (currentModel, context, options = {}) => {
      let destination: string | undefined;
      return original(currentModel, context, {
        ...options,
        onPayload: async (payload, requestModel) => {
          options.signal?.throwIfAborted();
          const next = await options.onPayload?.(payload, requestModel) ?? payload;
          options.signal?.throwIfAborted();
          const policy = isObject(next) ? (next as { [REQUEST_POLICY]?: RequestPolicy })[REQUEST_POLICY] : undefined;
          const usingOAuth = policy?.usingOAuth ?? registry.isUsingOAuth(currentModel);
          const state = oauthState(currentModel, options, usingOAuth);
          destination = state?.tier === "free" ? XAI_CLI : undefined;
          if (isObject(next) && Array.isArray(next.input) && next.input.some(item => isObject(item) && item.type === "compaction")) {
            const checkpoint = policy?.checkpoint;
            if (!checkpoint || checkpoint.route !== routeIdentity(currentModel)) {
              throw new GrokCompactionError("Grok checkpoint request metadata is missing; reload the compaction extension before replaying.");
            }
            assertCheckpointAuth(checkpoint, usingOAuth, state);
            if (state) {
              destination = XAI_API;
            }
          }
          return next;
        },
        fetch: async (input, init) => {
          const send = options.fetch ?? globalThis.fetch;
          if (!destination) return send(input, init);
          const request = new Request(input, init);
          if (request.url !== `${baseUrl(currentModel.baseUrl)}/responses` || request.method !== "POST") {
            throw new GrokCompactionError("Unexpected OAuth replay destination; request cancelled.");
          }
          // Preserve the serialized body and apply the destination's header contract.
          return send(`${destination}/responses`, {
            method: "POST", headers: destination === XAI_CLI ? freeHeaders(request, currentModel) : apiHeaders(request.headers.get("authorization") ?? "", request.headers.get("accept") ?? "text/event-stream"),
            body: await request.text(), signal: request.signal, redirect: "error",
          });
        },
      });
    };
    streamSimple[ORIGINAL_STREAM] = original;
    pi.registerProvider(model.provider, { api: "openai-responses", streamSimple });
    installed.set(model.provider, { stream: streamSimple, original, registry });
  };
  const dispose = () => {
    for (const [id, entry] of installed) {
      if (entry.registry.getRegisteredProviderConfig(id)?.streamSimple === entry.stream) {
        entry.registry.registerProvider(id, { api: "openai-responses", streamSimple: entry.original });
      }
    }
    installed.clear();
    warned.clear();
  };
  return { install, prepare, dispose };
}
