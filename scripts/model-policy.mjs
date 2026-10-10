export const CONTEXT_CAP = 32768;
export const SOFT_CAP = 24576;

export function modelIdentity(id) {
  const colon = id.lastIndexOf(':');
  const tagged = colon > id.lastIndexOf('/');
  const name = (tagged ? id.slice(0, colon) : id).replace(/-(?:32|64)k$/i, '');
  const tag = (tagged ? id.slice(colon + 1) : 'latest').replace(/-(?:32|64)k$/i, '');
  return `${name}:${tag}`;
}

export function alias32k(id) { return `${modelIdentity(id)}-32k`; }
export function configuredContext(show) { return Number(/^num_ctx\s+(\d+)\s*$/m.exec(show?.parameters || '')?.[1] || 0); }

export function nativeContext(show, fallback = CONTEXT_CAP) {
  const info = show?.model_info || {};
  const architecture = info['general.architecture'];
  const candidate = info[`${architecture}.context_length`] ?? info.context_length ??
    Object.entries(info).find(([k]) => k.endsWith('.context_length'))?.[1] ?? show?.details?.context_length;
  const n = Number(candidate);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function cappedModel(model, cap = CONTEXT_CAP, maxOutput = 8192) {
  const window = Math.min(cap, Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : cap);
  return { ...model, contextWindow: window, maxTokens: Math.min(model.maxTokens || maxOutput, maxOutput, Math.max(1, Math.floor(window / 4))) };
}

export function compactionFor(window) {
  // Keep smaller-context models conservative; the full 32K window gets a 24K trigger.
  const threshold = window >= CONTEXT_CAP ? SOFT_CAP : Math.min(Math.floor(window / 2), SOFT_CAP);
  return { reserveTokens: window - threshold, keepRecentTokens: Math.min(4096, Math.floor(window / 4)) };
}

export function capConfiguration(config, catalog = [], cap = CONTEXT_CAP) {
  const result = structuredClone(config);
  result.providers ??= {};
  for (const provider of Object.values(result.providers)) {
    if (provider.models) provider.models = provider.models.map(m => cappedModel(m, cap));
    for (const override of Object.values(provider.modelOverrides || {})) {
      if (override.contextWindow != null) override.contextWindow = Math.min(cap, override.contextWindow);
      if (override.maxTokens != null) override.maxTokens = Math.min(8192, override.maxTokens);
    }
  }
  for (const model of catalog) {
    const provider = result.providers[model.provider] ??= {};
    provider.modelOverrides ??= {};
    const prior = provider.modelOverrides[model.id] || {};
    const effective = cappedModel({ ...model, ...prior }, cap);
    provider.modelOverrides[model.id] = { ...prior, contextWindow: effective.contextWindow, maxTokens: effective.maxTokens };
  }
  return result;
}
