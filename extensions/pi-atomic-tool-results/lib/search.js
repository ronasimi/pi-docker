// Discovery remains archived and directly retrievable, but is opt-in in browse/search.
export function archiveMatchesTool(archive, tool) {
  return tool ? archive.toolName === tool : archive.toolName !== 'tool_search';
}

function searchableText(archive) {
  const parts = [archive.toolName, archive.resultRef];
  for (const block of archive.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  if (archive.details !== undefined) {
    try { parts.push(JSON.stringify(archive.details)); } catch {}
  }
  return parts.join("\n");
}

function snippet(text, needle, radius = 220) {
  const lower = text.toLowerCase();
  const i = lower.indexOf(needle.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function searchArchives(archives, { query, tool, limit = 10 } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const words = needle.split(/\s+/).filter(Boolean);
  const results = [];
  for (const archive of archives.values()) {
    if (!archiveMatchesTool(archive, tool)) continue;
    const hay = searchableText(archive);
    const lower = hay.toLowerCase();
    let score = 0;
    if (lower.includes(needle)) score += 10;
    for (const word of words) if (lower.includes(word)) score += 1;
    if (!score) continue;
    results.push({
      resultRef: archive.resultRef,
      entryId: archive.entryId,
      toolName: archive.toolName,
      isError: archive.isError,
      timestamp: archive.timestamp,
      sizeBytes: archive.sizeBytes,
      score,
      snippet: snippet(hay, words.find((w) => lower.includes(w)) ?? needle),
    });
  }
  return results.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp).slice(0, limit);
}
