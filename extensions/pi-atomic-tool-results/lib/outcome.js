export function resultData(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const texts = (result?.content ?? []).filter(b => b?.type === 'text');
  if (texts.length !== 1) return undefined;
  try { return JSON.parse(texts[0].text); } catch { return undefined; }
}

// Transport success and observation completeness are separate dimensions.
export function classifyOutcome(result) {
  const data = resultData(result);
  const unavailable = data?.available === false || data?.success === false ||
    /^(?:error|failed|unavailable|not_found|denied|cancelled)$/i.test(String(data?.status ?? ''));
  return {
    execution: result?.isError ? 'failed' : 'ok',
    domain: unavailable ? 'unavailable' : data?.status ?? 'observed',
    complete: data?.complete === true,
    usable: !result?.isError && !unavailable,
    data,
  };
}
