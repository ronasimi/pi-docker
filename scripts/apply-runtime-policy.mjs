#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, loadSdk, isMain } from './config-common.mjs';
import { capConfiguration, compactionFor, CONTEXT_CAP, SOFT_CAP } from './model-policy.mjs';

export function migrateModelSelections(state, aliases, available) {
  const convert = value => {
    if (typeof value === 'string' && value.startsWith('ollama/')) {
      const next = aliases[value.slice(7)];
      if (next && available.has(next)) return `ollama/${next}`;
    }
    return value;
  };
  const walk = (value, key = '') => {
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (!value || typeof value !== 'object') return /model/i.test(key) ? convert(value) : value;
    const result = { ...value };
    for (const [name, item] of Object.entries(value)) {
      if (name === 'providerKeys' || name === 'projectProviderKeys') continue;
      if (name === 'projectModels') result[name] = Object.fromEntries(Object.entries(item).map(([cwd, id]) => [cwd, convert(id)]));
      else result[name] = walk(item, name);
    }
    return result;
  };
  return walk(state);
}

export async function applyRuntimePolicy({ env = process.env } = {}) {
  const agentDir = env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
  const webDir = env.PI_WEB_DATA_DIR || '/home/pi/.pi-web';
  const configDir = env.PI_DEFAULT_CONFIG_DIR || '/etc/pi';
  const webRoot = env.PI_WEB_UI_ROOT || '/opt/pi-runtime/node_modules/pi-web-ui';
  const modelsFile = env.PI_MODELS_FILE || path.join(agentDir, 'models.json');
  const sdk = await loadSdk(env.PI_SDK_ROOT);
  // Catalog composition is offline and does not read/execute credential commands.
  const runtime = await sdk.ModelRuntime.create({ modelsPath: modelsFile, refreshOnCreate: false });
  if (runtime.getError()) throw new Error(`Invalid model configuration: ${runtime.getError()}`);
  const bundledCatalog = runtime.getModels();
  const stored = await readJson(path.join(agentDir, 'models-store.json'));
  // Restore newer cached provider catalogs through the public provider hook,
  // without availability checks, auth resolution or network refreshes.
  for (const provider of runtime.getProviders()) if (stored[provider.id] && provider.refreshModels) {
    await provider.refreshModels({ stored: stored[provider.id], allowNetwork: false, signal: new AbortController().signal,
      publish: async publication => { publication.update?.(); return true; } });
  }
  // Cached provider publications can replace their visible catalog. Retain caps
  // for both bundled and cached IDs so a new session cannot revive an uncapped model.
  const catalog = [...new Map([...bundledCatalog,...runtime.getModels()].map(model=>[`${model.provider}/${model.id}`,model])).values()];
  const config = capConfiguration(await readJson(modelsFile), catalog);
  await writeJson(modelsFile, config);
  const windows = new Map(catalog.map(m => [`${m.provider}/${m.id}`, config.providers[m.provider].modelOverrides[m.id].contextWindow]));
  const aliases = (await readJson(path.join(agentDir, 'model-aliases-32k.json'))).aliases || {};
  const ollamaIds = new Set(config.providers.ollama?.models?.map(m => m.id));

  const defaults = await readJson(path.join(configDir, 'default-settings.json'));
  const previous = await readJson(path.join(agentDir, 'settings.json'));
  const extensionPath = env.PI_ATOMIC_EXTENSION_PATH || '/opt/pi-extensions/pi-atomic-tool-results';
  const nativeServicesPath = env.PI_NATIVE_SERVICES_PATH || '/opt/pi-extensions/pi-native-services';
  const extensions = (previous.extensions || []).filter(p => !/pi-atomic-tool-results|pi-native-services|tool-search-default-limit|builtin:(mcp|tool-search|codemode|llama\.cpp)$/.test(p));
  const overrides = { ...previous.compaction?.modelOverrides };
  for (const [key, window] of windows) {
    if (window < CONTEXT_CAP || overrides[key]) overrides[key] = { ...overrides[key], ...compactionFor(window) };
  }
  const settings = {
    ...defaults, ...previous,
    defaultTools: defaults.defaultTools,
    // Pi resolves a package's manifest to its entry file before applying resource
    // exclusions. Excluding only the directory leaves index.js and its hooks live.
    extensions: [...extensions, ...defaults.extensions.filter(p => !/pi-atomic-tool-results|pi-native-services/.test(p)), nativeServicesPath, extensionPath,
      '!extensions/pi-atomic-tool-results/**', '-extensions/pi-atomic-tool-results/index.js', '-extensions/tool-search-default-limit.js'],
    compaction: { ...previous.compaction, ...defaults.compaction, modelOverrides: overrides },
    retry: { ...previous.retry, ...defaults.retry, provider: { ...previous.retry?.provider, ...defaults.retry.provider } },
  };
  if (settings.defaultProvider === 'ollama' && aliases[settings.defaultModel] && ollamaIds.has(aliases[settings.defaultModel])) settings.defaultModel = aliases[settings.defaultModel];
  if (settings.defaultProvider === 'ollama' && !ollamaIds.has(settings.defaultModel)) {
    const preferred = [...ollamaIds].find(id => /gemma4:e4b.*32k/.test(id));
    settings.defaultModel = preferred || [...ollamaIds][0] || settings.defaultModel;
  }
  for (const field of ['enabledModels']) if (settings[field]) settings[field] = settings[field].map(id => {
    if (id.startsWith('ollama/') && aliases[id.slice(7)]) return `ollama/${aliases[id.slice(7)]}`;
    return aliases[id] || id;
  });
  const thinking = {};
  for (const [id, level] of Object.entries(settings.modelThinkingLevels || {})) {
    thinking[id.startsWith('ollama/') && aliases[id.slice(7)] ? `ollama/${aliases[id.slice(7)]}` : id] = level;
  }
  if (Object.keys(thinking).length) settings.modelThinkingLevels = thinking;
  await writeJson(path.join(agentDir, 'settings.json'), settings);

  const { AGENT_TOOL_CATALOG } = await import(pathToFileURL(path.join(webRoot, 'dist/server/tool-manager.js')));
  let state = migrateModelSelections(await readJson(path.join(webDir, 'client-state.json')), aliases, ollamaIds);
  const global = state.__settings__ ??= { projects: [] };
  const prior = global.settings || {};
  const webDefaults = await readJson(path.join(configDir, 'default-web-settings.json'));
  const shortCaps = Object.fromEntries([...windows].filter(([, w]) => w < CONTEXT_CAP && w >= 4000).map(([key, w]) => [key, Math.min(SOFT_CAP, Math.floor(w / 2))]));
  if (Object.keys(shortCaps).length > 64) throw new Error('Web UI supports at most 64 short-context overrides');
  const requiredExtensions = /pi-atomic-tool-results|pi-native-services|^(?:builtin:)?(?:mcp|tool-search)$/;
  global.settings = {
    ...prior, ...webDefaults,
    disabledAgentTools: [...new Set([...AGENT_TOOL_CATALOG.map(t => t.name), 'powershell', 'ls', 'grep', 'find'])],
    disabledExtensions: (prior.disabledExtensions || []).filter(p => !requiredExtensions.test(p)),
    disabledPluginTools: (prior.disabledPluginTools || []).filter(p => !['tool_search', 'tool_invoke', 'result_get', 'result_list'].includes(p)),
    softCapByModel: shortCaps,
  };
  await writeJson(path.join(webDir, 'client-state.json'), state);
  console.error(`[pi] Applied 32K policy to ${catalog.length} chat models; disabled ${AGENT_TOOL_CATALOG.length} optional Web UI tools.`);
  return { models: config, settings, state, modelCount: catalog.length };
}

if (isMain(import.meta.url)) applyRuntimePolicy().catch(error => { console.error(`[pi] Policy failed: ${error.message}`); process.exitCode = 1; });
