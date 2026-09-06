// Checkpoint projection includes MIT-licensed portions by Narumi; see LICENSE.
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Item = Record<string, unknown>;
export const MAX_BYTES = 8 * 1024 * 1024;
const KIND = "pi-grok-native-compaction";

export interface Checkpoint {
  kind: typeof KIND;
  version: 1;
  checkpointId: string;
  route: string;
  output: Item[];
  keptMessageFingerprints: string[];
  oauthAccount?: string;
}

export function isObject(value: unknown): value is Item {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateOutput(value: unknown): Item[] {
  if (!Array.isArray(value) || value.length !== 1 || !isObject(value[0]) ||
      value[0].type !== "compaction" || typeof value[0].encrypted_content !== "string" ||
      !value[0].encrypted_content || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) {
    throw new Error("xAI returned an invalid or oversized compaction output");
  }
  return structuredClone(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, stableValue(child)]));
}

export function fingerprint(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify(stableValue(message))).digest("hex");
}

export function summary(id: string): string {
  return `Grok opaque checkpoint ${id}. Full history replay requires pi-grok-compaction on the original provider, model and endpoint. Only retained recent messages are available without replay.`;
}

export function marker(id: string): string {
  return `[PI_GROK_CHECKPOINT:${id}] Opaque history requires pi-grok-compaction on the original route. Report unavailable history if this marker reaches the model.`;
}

export function createCheckpoint(route: string, output: unknown, kept: readonly AgentMessage[], oauthAccount?: string): Checkpoint {
  return {
    kind: KIND, version: 1, checkpointId: randomUUID(), route,
    output: validateOutput(output), keptMessageFingerprints: kept.map(fingerprint),
    ...(oauthAccount ? { oauthAccount } : {}),
  };
}

export function latestCheckpoint(entries: readonly SessionEntry[]): Checkpoint | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "compaction") continue;
    const value = entry.details;
    if (!isObject(value) || value.kind !== KIND) return undefined;
    if (value.version !== 1 || typeof value.checkpointId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.checkpointId) || typeof value.route !== "string" ||
        (value.oauthAccount !== undefined && (typeof value.oauthAccount !== "string" || !/^[a-f0-9]{64}$/.test(value.oauthAccount))) ||
        !Array.isArray(value.keptMessageFingerprints) ||
        !value.keptMessageFingerprints.every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) {
      throw new Error("Grok checkpoint metadata is invalid; restore the session before compacting");
    }
    validateOutput(value.output);
    return structuredClone(value) as unknown as Checkpoint;
  }
  return undefined;
}

export function projectMessages(messages: readonly AgentMessage[], checkpoint: Checkpoint): AgentMessage[] {
  const start = messages.findIndex(m => m.role === "compactionSummary" && m.summary === summary(checkpoint.checkpointId));
  if (start < 0) throw new Error("Grok checkpoint summary is missing from the active context");
  const timestamp = messages[start].timestamp;
  const isOldSummary = (message: AgentMessage) => message.role === "compactionSummary" &&
    Number.isFinite(message.timestamp) && Number.isFinite(timestamp) && message.timestamp < timestamp;
  let end = start + 1;
  for (const expected of checkpoint.keptMessageFingerprints) {
    while (end < messages.length && fingerprint(messages[end]) !== expected && isOldSummary(messages[end])) end++;
    if (end >= messages.length || fingerprint(messages[end]) !== expected) {
      throw new Error("Grok retained history changed; checkpoint projection cancelled");
    }
    end++;
  }
  while (end < messages.length && isOldSummary(messages[end])) end++;
  return [
    ...messages.slice(0, start),
    { role: "user", content: [{ type: "text", text: marker(checkpoint.checkpointId) }], timestamp },
    ...messages.slice(end),
  ];
}

export function replay(payload: unknown, checkpoint: Checkpoint): Item {
  if (!isObject(payload) || !Array.isArray(payload.input)) throw new Error("Grok replay requires Responses input");
  const matches = payload.input.flatMap((item, index) =>
    isObject(item) && item.role === "user" && Array.isArray(item.content) && item.content.length === 1 &&
    isObject(item.content[0]) && item.content[0].type === "input_text" &&
    item.content[0].text === marker(checkpoint.checkpointId) ? [index] : []);
  if (matches.length !== 1) throw new Error("Grok replay requires exactly one checkpoint marker");
  const index = matches[0];
  // xAI's complete output replaces the old conversation and stays at the head.
  return { ...payload, input: [...validateOutput(checkpoint.output), ...payload.input.slice(0, index), ...payload.input.slice(index + 1)] };
}
