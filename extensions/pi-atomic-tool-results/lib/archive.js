import { redact } from './redact.js';
export const CUSTOM_TYPE = "pi.atomic-tool-result";
export const ARCHIVE_VERSION = 1;

const SECRET_KEY = /(api[_-]?key|authorization|bearer|token|password|passwd|secret|credential|cookie|private[_-]?key)/i;

export function resultRef(toolCallId) {
  return `result:${toolCallId}`;
}

export function sanitizeInput(value, depth = 0) {
  if (depth > 8) return "[depth-limited]";
  if (Array.isArray(value)) return value.map((v) => sanitizeInput(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizeInput(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function makeArchive(event, { storeInput = true } = {}) {
  event = redact(event);
  if (event.structuredContent !== undefined && /^mcp__/.test(event.toolName) && /"truncated"\s*:\s*true/.test(JSON.stringify(event.content).replaceAll('\\"','"'))) event = {...event,content:[{type:"text",text:JSON.stringify(event.structuredContent)}]};
  const payload = {
    version: ARCHIVE_VERSION,
    resultRef: resultRef(event.toolCallId),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
    isError: Boolean(event.isError),
    timestamp: Date.now(),
    ...(storeInput ? { input: sanitizeInput(event.input ?? {}) } : {}),
    content: structuredCloneSafe(event.content ?? []),
    ...(event.structuredContent === undefined ? {} : { structuredContent: structuredCloneSafe(event.structuredContent) }),
    ...(event.details === undefined ? {} : { details: structuredCloneSafe(event.details) }),
    ...(event.usage === undefined ? {} : { usage: structuredCloneSafe(event.usage) }),
  };
  payload.sizeBytes = jsonBytes({ content: payload.content, structuredContent: payload.structuredContent, details: payload.details });
  return payload;
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
}

export function isArchiveEntry(entry) {
  return Boolean(
    entry &&
      entry.type === "custom" &&
      entry.customType === CUSTOM_TYPE &&
      entry.data &&
      typeof entry.data === "object" &&
      typeof entry.data.resultRef === "string",
  );
}

export function archivesFromBranch(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (!isArchiveEntry(entry)) continue;
    map.set(entry.data.resultRef, { ...redact(entry.data), entryId: entry.id });
  }
  return map;
}

export function findArchive(entries, ref) {
  return archivesFromBranch(entries).get(ref);
}
