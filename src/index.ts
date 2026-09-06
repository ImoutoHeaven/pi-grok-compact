import {
  buildContextEntries, buildSessionContext, convertToLlm, sessionEntryToContextMessages,
  type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { createCheckpoint, latestCheckpoint, projectMessages, replay, summary } from "./checkpoint.ts";
import { capturePayload, GrokCompactionError, isGrok, requestCompaction, resolveRoute, routeIdentity } from "./remote.ts";
import { assertOAuthReplay, createOAuthReplayRouter, oauthCompactRoute, oauthState } from "./oauth.ts";

function keptMessages(event: SessionBeforeCompactEvent) {
  const entries = buildContextEntries(event.branchEntries, event.branchEntries.at(-1)?.id ?? null);
  const index = entries.findIndex(e => e.id === event.preparation.firstKeptEntryId);
  if (index < 0) throw new Error("Pi compaction cut point is missing");
  return entries.slice(index).flatMap(sessionEntryToContextMessages);
}

export function createGrokCompaction(options: {
  fetch?: typeof globalThis.fetch;
} = {}) {
  return (pi: ExtensionAPI) => {
    const installReplayRouter = createOAuthReplayRouter(pi);
    const active = (ctx: ExtensionContext) => latestCheckpoint(ctx.sessionManager.getBranch());
    const compatible = (ctx: ExtensionContext, route: string) => isGrok(ctx.model) && routeIdentity(ctx.model) === route;

    pi.on("session_before_compact", async (event, ctx) => {
      if (!isGrok(ctx.model)) return;
      const model = ctx.model;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      let routeId: string;
      const owned = () => !event.signal.aborted && ctx.sessionManager.getSessionId() === sessionId &&
        ctx.sessionManager.getLeafId() === leafId && ctx.model !== undefined && routeIdentity(ctx.model) === routeId;
      ctx.ui.setStatus("grok-compact", "Grok server compaction…");
      try {
        routeId = routeIdentity(model);
        const prior = latestCheckpoint(event.branchEntries);
        if (prior && prior.route !== routeId) throw new Error("Resume the original Grok route before compacting its checkpoint");
        const session = buildSessionContext(event.branchEntries, event.branchEntries.at(-1)?.id ?? null);
        const messages = prior ? projectMessages(session.messages, prior) : session.messages;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!owned()) return { cancel: true };
        if (!auth.ok) throw new Error("Grok provider authentication is unavailable");
        const oauth = oauthState(model, auth, ctx.modelRegistry.isUsingOAuth(model));
        if (prior?.oauthAccount && !oauth) throw new GrokCompactionError("This native checkpoint requires its original OAuth login; restore that login before compacting.");
        installReplayRouter(ctx);
        if (oauth?.tier === "free") {
          if (prior) assertOAuthReplay(prior, oauth);
          ctx.ui.notify("Free/X Basic OAuth account: using Pi's built-in prompt-summary compaction.", "info");
          return undefined;
        }
        if (prior && oauth) assertOAuthReplay(prior, oauth);
        const provider = ctx.modelRegistry.getProvider(model.provider);
        if (!provider) throw new Error("Grok provider is unavailable");
        const captured = await capturePayload({
          provider, model, context: { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages) },
          auth, signal: event.signal, sessionId,
        });
        if (!owned()) return { cancel: true };
        const payload = prior ? replay(captured, prior) : captured;
        const result = await requestCompaction({
          route: oauth ? oauthCompactRoute(oauth) : resolveRoute(model, auth), model: model.id,
          input: payload.input as unknown[],
          sessionId: typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key : undefined,
          instructions: typeof payload.instructions === "string" ? payload.instructions : undefined,
          signal: event.signal, fetch: options.fetch,
        });
        if (!owned()) return { cancel: true };
        const details = createCheckpoint(routeId, result.output, keptMessages(event), oauth?.account);
        return { compaction: {
          summary: summary(details.checkpointId), firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore, details,
        } };
      } catch (error) {
        // Surface locally authored errors; provider errors can echo bodies or credentials.
        if (!event.signal.aborted) ctx.ui.notify(error instanceof GrokCompactionError ? error.message : "Grok server compaction failed; original history retained. Check the endpoint, credentials and context limit, then retry /compact.", "warning");
        return { cancel: true };
      } finally {
        if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus("grok-compact", undefined);
      }
    });

    pi.on("context", (event, ctx) => {
      installReplayRouter(ctx);
      const checkpoint = active(ctx);
      if (!checkpoint || !compatible(ctx, checkpoint.route)) return;
      return { messages: projectMessages(event.messages, checkpoint) };
    });

    pi.on("before_provider_request", (event, ctx) => {
      const checkpoint = active(ctx);
      if (!checkpoint || !compatible(ctx, checkpoint.route)) return;
      return replay(event.payload, checkpoint);
    });

    const warnRoute = (_event: unknown, ctx: ExtensionContext) => {
      installReplayRouter(ctx);
      const checkpoint = active(ctx);
      if (checkpoint && !compatible(ctx, checkpoint.route)) {
        ctx.ui.notify("Grok checkpoint replay requires its original provider, model and endpoint. This route receives only the fallback marker and retained recent messages.", "warning");
      }
    };
    pi.on("model_select", warnRoute);
    pi.on("session_start", warnRoute);
  };
}

export default createGrokCompaction();
