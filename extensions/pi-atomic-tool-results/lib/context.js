import { compactOrInlineContent, leaseExpiredEnvelope } from "./compact.js";

const INTERNAL_TOOLS = new Set(["result_get", "result_search", "result_list"]);

export function compactHistoricalToolResults(messages, archives, rehydrationLeases, ephemeralRehydrations, archiveFailures, config) {
  let changed = false;
  const next = messages.map((message) => {
    if (!message || message.role !== "toolResult" || !message.toolCallId) return message;

    // Discovery responses are immutable: each unique schema appears once when
    // discovered, and older provider request prefixes are never rewritten.
    if (message.details?.atomicSchema) return message;

    // result_get deliberately hydrates one bounded slice for exactly one provider
    // request. Its persisted transcript entry is always a tiny lease marker.
    if (message.toolName === "result_get") {
      if (message.details?.atomicDurable) return message;
      const ephemeral = ephemeralRehydrations.get(message.toolCallId);
      if (ephemeral) {changed = true; return {...message,...ephemeral};}
      return message;
    }

    // result_search and result_list are already bounded by the extension. Keep
    // their transcript representation unchanged so the prompt prefix remains
    // byte-stable across later provider requests.
    if (INTERNAL_TOOLS.has(message.toolName)) return message;

    // New v0.1.1 results are compact from the first request onward. Never rewrite
    // an already-atomic transcript entry: stable prefixes are better for KV-cache
    // reuse than progressively shrinking historical messages.
    if (message.details?.atomic === true && message.details?.resultRef) return message;

    // Persistence failure is fail-open: without a durable archive we retain the
    // raw result rather than replacing it with a reference that cannot be read.
    if (archiveFailures?.has(message.toolCallId)) return message;

    // Compatibility/migration path: if an older/raw transcript message has a
    // matching archive entry, compact it once. Subsequent requests see the stable
    // replacement returned by the context hook for this active session.
    const archive = archives.get(`result:${message.toolCallId}`);
    if (!archive) return message;
    changed = true;
    const rendered = compactOrInlineContent(archive, { previewChars: config.previewChars });
    if (rendered.inlineRaw) return message;
    return {
      ...message,
      content: rendered.content,
      details: {
        ...(message.details && typeof message.details === "object" ? message.details : {}),
        atomic: true,
        resultRef: archive.resultRef,
        archivedBytes: archive.sizeBytes,
      },
    };
  });
  return changed ? next : messages;
}

export function isInternalTool(name) {
  return INTERNAL_TOOLS.has(name);
}
