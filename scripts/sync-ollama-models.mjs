#!/usr/bin/env node
import path from 'node:path';
import { readJson, writeJson, integer, isMain } from './config-common.mjs';
import { modelIdentity, configuredContext, nativeContext, cappedModel, capConfiguration, CONTEXT_CAP } from './model-policy.mjs';
import { configureAliases } from './configure-ollama-32k.mjs';

export async function syncModels({ env = process.env, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const baseUrl = (env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434').replace(/\/$/, '');
  const output = env.PI_MODELS_FILE || path.join(env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent', 'models.json');
  const cap = integer(env.PI_MODEL_CONTEXT_CAP ?? env.PI_OLLAMA_CONTEXT_CAP, CONTEXT_CAP, 2048, CONTEXT_CAP, 'context cap');
  const maxOutput = integer(env.PI_OLLAMA_MAX_TOKENS, 4096, 256, 8192, 'Ollama output limit');
  const retrySeconds = integer(env.PI_OLLAMA_DISCOVERY_RETRY_SECONDS, 30, 0, 120, 'discovery retry seconds');
  const old = await readJson(output);
  const fallback = await readJson(env.PI_MODELS_FALLBACK || '/etc/pi/models-fallback.json');
  const config = old.providers ? old : { ...fallback, ...old, providers: { ...fallback.providers, ...old.providers } };
  const overrides = await readJson(env.PI_MODELS_OVERRIDES || '/etc/pi/models-overrides.json');
  const request = async (endpoint, body) => {
    const response = await fetchImpl(`${baseUrl}/api/${endpoint}`, {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Ollama ${endpoint}: HTTP ${response.status}`);
    const data = await response.json(); if (data.error) throw new Error(`Ollama ${endpoint}: ${data.error}`);
    return data;
  };
  let tags, error;
  const deadline = Date.now() + retrySeconds * 1000;
  do {
    try { tags = await request('tags'); break; }
    catch (cause) { error = cause; if (Date.now() >= deadline) break; await sleep(1500); }
  } while (true);
  if (tags && env.PI_CREATE_32K_ALIASES === 'true') {
    await configureAliases({ baseUrl, fetchImpl, timeoutMs: 30000 });
    tags = await request('tags');
  }
  let discovered = [];
  if (tags) {
    const verified = new Map();
    for (const tag of tags.models || []) {
      if (!tag.name) continue;
      let show;
      try { show = await request('show', { model: tag.name }); }
      catch {
        const cached = config.providers?.ollama?.models?.find(m => m.id === tag.name);
        if (cached) discovered.push(cappedModel(cached, cap, maxOutput));
        console.error(`[pi] Could not inspect ${tag.name}; ${cached ? 'using cached metadata' : 'omitting until inspection succeeds'}`);
        continue;
      }
      const capabilities = show.capabilities || tag.capabilities || [];
      if (!capabilities.includes('completion')) continue;
      const nativeThinking = Array.isArray(show.thinking?.values)
        ? show.thinking.values.some(value => value === true || typeof value === 'string')
        : capabilities.includes('thinking');
      const contextWindow = Math.min(cap, configuredContext(show) || nativeContext(show));
      const previous = config.providers?.ollama?.models?.find(m => m.id === tag.name) || {};
      const override = overrides.models?.[tag.name] || overrides.models?.[modelIdentity(tag.name)] || overrides[tag.name] || {};
      const model = cappedModel({
        ...previous, id: tag.name, name: tag.name, reasoning: nativeThinking,
        input: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...override, contextWindow, maxTokens: override.maxTokens || maxOutput,
        compat: { ...previous.compat, ...override.compat, supportsDeveloperRole: false, supportsReasoningEffort: nativeThinking },
      }, cap, maxOutput);
      if (/white[-_]?rabbit[-_]?neo|^security-agent(?::|$)/i.test(tag.name)) model.reasoning = true;
      model.name = `${(override.name || modelIdentity(tag.name)).replace(/\s*\[\d+K\]$/i, '')} [${Math.round(model.contextWindow / 1024)}K]`;
      discovered.push(model);
      if (configuredContext(show) === CONTEXT_CAP && /-32k(?::[^/]+)?$/i.test(tag.name)) verified.set(modelIdentity(tag.name), tag.name);
    }
    const hide = !['0', 'false', 'no'].includes(String(env.PI_OLLAMA_HIDE_ALIAS_SOURCES ?? 'true').toLowerCase());
    const mapping = {};
    for (const model of discovered) { const target = verified.get(modelIdentity(model.id)); if (target) mapping[model.id] = target; }
    discovered = discovered.filter(m => !hide || !verified.has(modelIdentity(m.id)) || verified.get(modelIdentity(m.id)) === m.id);
    if (!discovered.length) throw new Error('Ollama returned no inspectable completion models; retained catalog was not replaced');
    discovered.sort((a, b) => a.id.localeCompare(b.id));
    const previous = config.providers?.ollama || {};
    config.providers ??= {};
    config.providers.ollama = {
      ...previous, baseUrl: `${baseUrl}/v1`, api: 'openai-completions', apiKey: previous.apiKey || 'ollama',
      compat: { ...previous.compat, supportsDeveloperRole: false }, models: discovered,
    };
    for (const m of discovered) if (config.providers.ollama.modelOverrides?.[m.id]) {
      const projectOverride = overrides.models?.[m.id] || overrides.models?.[modelIdentity(m.id)] || overrides[m.id] || {};
      Object.assign(config.providers.ollama.modelOverrides[m.id], projectOverride, { contextWindow: m.contextWindow, maxTokens: m.maxTokens, name: m.name });
    }
    await writeJson(path.join(path.dirname(output), 'model-aliases-32k.json'), { version: 1, contextWindow: cap, aliases: mapping });
  } else {
    if (!config.providers?.ollama?.models?.length) throw new Error(`Ollama unavailable and no fallback catalog: ${error.message}`);
    console.error('[pi] Ollama unavailable; preserving all providers and capping the cached catalog.');
  }
  const result = capConfiguration(config, [], cap);
  await writeJson(output, result);
  console.error(`[pi] Catalog synchronized: ${result.providers.ollama.models.length} Ollama chat models, context <= ${cap}`);
  return result;
}

if (isMain(import.meta.url)) syncModels().catch(error => { console.error(`[pi] ${error.message}`); process.exitCode = 1; });
