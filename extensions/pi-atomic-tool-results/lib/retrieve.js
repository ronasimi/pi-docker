function parseJsonText(archive) {
  const textParts = (archive.content ?? []).filter((p) => p?.type === "text" && typeof p.text === "string");
  if (textParts.length !== 1) return undefined;
  const text = textParts[0].text.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function pathSegments(selector) {
  if (!selector) return [];
  return selector
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean)
    .map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment);
}

function atPath(root, selector) {
  let value = root;
  for (const segment of pathSegments(selector)) {
    if (value == null || ['__proto__', 'constructor', 'prototype'].includes(segment) || !Object.hasOwn(Object(value), segment)) return undefined;
    value = value[segment];
  }
  return value;
}

export function selectArchiveValue(archive, selector) {
  if (!selector || selector === "content") return archive.content;
  if (selector === "details") return archive.details;
  if (selector === "structured" || selector === "structuredContent") return archive.structuredContent;
  if (selector === "input") return archive.input;
  if (selector === "meta") {
    const { content, details, input, ...meta } = archive;
    return meta;
  }
  if (selector === "json") return parseJsonText(archive);
  if (selector.startsWith("json.")) return atPath(parseJsonText(archive), selector.slice(5));
  if (selector.startsWith("content.")) return atPath(archive.content, selector.slice(8));
  if (selector.startsWith("details.")) return atPath(archive.details, selector.slice(8));
  if (selector.startsWith("structured.")) return atPath(archive.structuredContent, selector.slice(11));
  if (selector.startsWith("structuredContent.")) return atPath(archive.structuredContent, selector.slice(18));
  if (selector.startsWith("input.")) return atPath(archive.input, selector.slice(6));
  return undefined;
}

function textPage(value, offset, maxChars) {
  let lo=0, hi=Math.min(value.length-offset, Math.max(0,maxChars));
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(JSON.stringify(value.slice(offset,offset+mid)).length<=maxChars)lo=mid;else hi=mid-1;}
  return value.slice(offset,offset+lo);
}

export function boundValue(value, { offset = 0, limit = 100, maxChars = 12000 } = {}) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (typeof value === "string") {
    const text = textPage(value, safeOffset, maxChars);
    return { value: text, truncated: safeOffset + text.length < value.length, nextOffset: safeOffset + text.length };
  }
  if (Array.isArray(value)) {
    const items = value.slice(safeOffset, safeOffset + safeLimit);
    while (items.length > 1 && JSON.stringify(items).length > maxChars) items.pop();
    if (items.length && JSON.stringify(items).length > maxChars) return {value:[],truncated:true,nextOffset:safeOffset,totalItems:value.length,availableSelector: String(safeOffset),error:"Item exceeds budget; select this item's fields or serialized text with character pagination."};
    return {value:items,truncated:safeOffset+items.length<value.length,nextOffset:safeOffset+items.length,totalItems:value.length};
  }
  let rendered = JSON.stringify(value, null, 2);
  if (rendered === undefined) rendered = String(value);
  const totalChars = rendered.length;
  rendered = textPage(rendered, safeOffset, maxChars);
  const truncated = safeOffset + rendered.length < totalChars;
  return { value: rendered, truncated, nextOffset: truncated ? safeOffset + rendered.length : undefined };
}

export function renderBoundedSelection(archive, selector, opts) {
  const selected = selectArchiveValue(archive, selector);
  if (selected === undefined) {
    return { ok: false, error: `Selector not found: ${selector || "content"}` };
  }
  const overhead = JSON.stringify({ok:true,resultRef:archive.resultRef,toolName:archive.toolName,selector:selector||'content',value:null,truncated:true,nextOffset:100000000,totalItems:100000000}).length;
  const bounded = boundValue(selected, {...opts,maxChars:Math.max(1,(opts?.maxChars??12000)-overhead-100)});
  return {
    ok: true,
    resultRef: archive.resultRef,
    toolName: archive.toolName,
    selector: selector || "content",
    ...bounded,
  };
}

// maxChars is shared across fields and includes their JSON wrappers. An omitted
// selector is never silently advanced over: nextSelectorOffset identifies it.
export function renderArchiveSelections(archive, selectors, opts = {}) {
  const maxChars = opts.maxChars ?? 12000;
  const start = Math.max(0, opts.selectorOffset ?? 0);
  const output = { ok: true, resultRef: archive.resultRef, selections: [], truncated: false, nextSelectorOffset: start };
  const sliceBudget = Math.max(32, Math.floor((maxChars - JSON.stringify(output).length - 80) / Math.max(1, selectors.length - start)) - 160);
  for (let index = start; index < selectors.length; index++) {
    const selection = renderBoundedSelection(archive, selectors[index], { ...opts, maxChars: sliceBudget });
    const candidate = { ...output, selections: [...output.selections, selection], nextSelectorOffset: index + 1, truncated: index + 1 < selectors.length };
    if (JSON.stringify(candidate).length > maxChars) break;
    Object.assign(output, candidate);
  }
  output.truncated = output.nextSelectorOffset < selectors.length;
  if (!output.selections.length && output.truncated) output.error = 'Projection metadata exceeds budget; request fewer selectors or a larger max_chars';
  return output;
}
