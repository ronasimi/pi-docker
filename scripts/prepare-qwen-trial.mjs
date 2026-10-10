#!/usr/bin/env node
import assert from 'node:assert/strict';
import { alias32k, configuredContext, nativeContext, CONTEXT_CAP } from './model-policy.mjs';
import { isMain } from './config-common.mjs';

export const QWEN_MODELS = Object.freeze({
  '4b': { source: 'qwen3.5:4b', name: 'Qwen 3.5 4B', download: 'approximately 3.3–4.0 GB, backend dependent' },
  distill: { source: 'tobestyledintro/qwen3.8-9b-distill:latest', name: 'Qwen 3.8 Distill 9B Q4_K_M', download: 'community package, approximately 6.7 GB' },
});
export const QWEN_PARAMETERS = { num_ctx: CONTEXT_CAP, num_predict: 4096, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1, presence_penalty: 0 };

export function qwenDefinition(key) {
  assert(Object.hasOwn(QWEN_MODELS, key), 'Use Qwen model key 4b or distill');
  return { key, ...QWEN_MODELS[key], model: alias32k(QWEN_MODELS[key].source) };
}

export function qwenProfile(show, key = '4b') {
  const definition = qwenDefinition(key);
  for (const capability of ['completion', 'tools', 'thinking']) assert(show.capabilities?.includes(capability), `Qwen lacks verified ${capability} capability`);
  assert(!show.remote_host && !show.remote_model, 'The trial requires a local model');
  assert(nativeContext(show, 0) >= CONTEXT_CAP, 'Native Qwen context must support 32K');
  const values = show.thinking?.values;
  if (Array.isArray(values)) {
    assert(values.includes(false), 'Qwen must support thinking off for this comparison');
    assert(values.some(v => v === true || typeof v === 'string'), 'Qwen must support thinking on');
  }
  const levels = Array.isArray(values) ? values.filter(v => typeof v === 'string') : [];
  const medium = levels.includes(show.thinking?.default) ? show.thinking.default : levels[Math.floor(levels.length / 2)];
  return {
    name: `${definition.name} [32K]`, reasoning: true,
    input: show.capabilities.includes('vision') ? ['text', 'image'] : ['text'],
    contextWindow: CONTEXT_CAP, maxTokens: 4096,
    compat: { thinkingFormat: 'openai', supportsDeveloperRole: false, supportsReasoningEffort: true, supportsStrictMode: false, maxTokensField: 'max_tokens' },
    thinkingLevelMap: { off: 'none', minimal: levels[0] || 'low', low: levels[0] || 'low', medium: medium || 'medium', high: levels.at(-1) || 'high', xhigh: null, max: null },
    // Pi 1.1.0 applies one sampling profile in both thinking modes. Ollama's
    // OpenAI endpoint accepts these fields; top_k stays on the native alias.
    samplingParams: { temperature: 0.6, top_p: 0.95, presence_penalty: 0 },
  };
}

function parameter(show, name) {
  return Number(new RegExp(`^${name}\\s+([\\d.]+)\\s*$`, 'm').exec(show?.parameters || '')?.[1] ?? NaN);
}

function inherited(source, alias) {
  return ['template', 'system', 'renderer', 'parser'].every(k => source[k] === undefined || alias?.[k] === source[k])
    && (!source.modelfile || !alias?.modelfile || /^FROM\s+(.+)$/m.exec(source.modelfile)?.[1] === /^FROM\s+(.+)$/m.exec(alias.modelfile)?.[1]);
}

export function verifyQwenAlias(source, alias) {
  assert.equal(configuredContext(alias), CONTEXT_CAP);
  for (const [key, value] of Object.entries(QWEN_PARAMETERS)) assert.equal(parameter(alias, key), value, `Alias parameter differs: ${key}`);
  assert(inherited(source, alias), 'Alias changed the source weights/template/system/renderer/parser');
}

export async function prepareQwen({ key = '4b', baseUrl = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434', fetchImpl = fetch, log = message => console.error(`[qwen] ${message}`) } = {}) {
  const definition = qwenDefinition(key);
  baseUrl = baseUrl.replace(/\/$/, '');
  const request = async (endpoint, body, { optional = false, timeoutMs = 120000 } = {}) => {
    const response = await fetchImpl(`${baseUrl}/api/${endpoint}`, {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (optional && response.status === 404) return;
    if (!response.ok) throw new Error(`Ollama ${endpoint}: HTTP ${response.status}`);
    const data = await response.json(); if (data.error) throw new Error(data.error);
    return data;
  };
  const version = await request('version');
  let source = await request('show', { model: definition.source }, { optional: true });
  if (!source) {
    log(`Pulling ${definition.source} (${definition.download})...`);
    const response = await fetchImpl(`${baseUrl}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: definition.source, stream: true }), signal: AbortSignal.timeout(7200000) });
    if (!response.ok) throw new Error(`Ollama pull: HTTP ${response.status}`);
    const decoder = new TextDecoder(); let buffer = '', last, progress = '';
    const status = line => {
      if (!line.trim()) return;
      last = JSON.parse(line); if (last.error) throw new Error(last.error);
      const bucket = last.total ? Math.floor(20 * (last.completed || 0) / last.total) * 5 : undefined;
      const key = `${last.status}:${last.digest || ''}:${bucket ?? ''}`;
      if (key !== progress) { log(`${last.status}${bucket === undefined ? '' : ` ${bucket}%`}`); progress = key; }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { status(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    buffer += decoder.decode(); status(buffer);
    assert.equal(last?.status, 'success', 'Ollama did not confirm the model pull');
    source = await request('show', { model: definition.source });
  }
  const profile = qwenProfile(source, key);
  const current = await request('show', { model: definition.model }, { optional: true });
  if (!current || !inherited(source, current) || Object.entries(QWEN_PARAMETERS).some(([k, v]) => parameter(current, k) !== v)) {
    log(`Creating ${definition.model} with the source template/parser and 32K allocation...`);
    const created = await request('create', { model: definition.model, from: definition.source, parameters: QWEN_PARAMETERS, stream: false });
    assert.equal(created.status, 'success');
  }
  const verified = await request('show', { model: definition.model });
  verifyQwenAlias(source, verified);
  const tags = await request('tags');
  const digest = tags.models?.find(m => m.name === definition.model)?.digest;
  assert(digest, 'Ollama did not list the created alias digest');
  log(`Verified ${definition.model}: context 32768, output 4096, native tools/thinking.`);
  return { version: 1, key, source: definition.source, model: definition.model, profile, ollamaVersion: version.version,
    digest, parameters: QWEN_PARAMETERS, preparedAt: new Date().toISOString() };
}

if (isMain(import.meta.url)) prepareQwen({ key: process.argv[2] || '4b' }).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(`[qwen] ${error.message}`); process.exitCode = 1; });
