import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = process.env.PI_TEST_SCRIPTS_DIR || path.join(root, 'scripts');
const { alias32k, modelIdentity, capConfiguration, compactionFor } = await import(pathToFileURL(path.join(scripts, 'model-policy.mjs')));
const { syncModels } = await import(pathToFileURL(path.join(scripts, 'sync-ollama-models.mjs')));
const { configureAliases } = await import(pathToFileURL(path.join(scripts, 'configure-ollama-32k.mjs')));
const { migrateModelSelections } = await import(pathToFileURL(path.join(scripts, 'apply-runtime-policy.mjs')));

function ollamaFixture(models) {
  const map = new Map(Object.entries(models));
  const creations = [];
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url).pathname.split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : {};
    let data;
    if (endpoint === 'tags') data = { models: [...map.keys()].map(name => ({ name })) };
    if (endpoint === 'show') { if (!map.has(body.model)) return new Response('', { status: 404 }); data = map.get(body.model); }
    if (endpoint === 'create') {
      creations.push(body);
      map.set(body.model, { ...structuredClone(map.get(body.from)), parameters: `num_ctx ${body.parameters.num_ctx}\ntemperature 0.6` });
      data = { status: 'success' };
    }
    return Response.json(data);
  };
  return { map, creations, fetchImpl };
}
const show = (ctx = 65536, native = 262144) => ({ capabilities: ['completion', 'tools', 'thinking', 'vision'], parameters: `num_ctx ${ctx}\ntemperature 0.6`, model_info: { 'general.architecture': 'gemma', 'gemma.context_length': native }, template: 'upstream tool template', parser: 'gemma', renderer: 'gemma', system: 'existing model system' });

test('32K alias identity handles tagged, untagged and registry-qualified names', () => {
  assert.equal(alias32k('gemma4:e4b-it-qat-64k'), 'gemma4:e4b-it-qat-32k');
  assert.equal(alias32k('nemotron-64k:latest'), 'nemotron:latest-32k');
  assert.equal(alias32k('localhost:5000/team/nemotron-64k:latest'), 'localhost:5000/team/nemotron:latest-32k');
  assert.equal(alias32k('nemotron:latest-32k'), 'nemotron:latest-32k');
  assert.equal(modelIdentity('nemotron'), 'nemotron:latest');
});

test('alias creation inherits templates, verifies num_ctx, and is idempotent', async () => {
  const fixture = ollamaFixture({ 'gemma4:e4b-it-qat': show(), 'gemma4:e4b-it-qat-64k': show(), 'nemotron-64k:latest': show() });
  const result = await configureAliases({ baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl });
  assert.equal(result.aliases['gemma4:e4b-it-qat-64k'], 'gemma4:e4b-it-qat-32k');
  assert.equal(result.aliases['nemotron-64k:latest'], 'nemotron:latest-32k');
  assert.equal(fixture.creations.length, 2);
  for (const body of fixture.creations) assert.deepEqual(Object.keys(body).sort(), ['from', 'model', 'parameters', 'stream']);
  await configureAliases({ baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl });
  assert.equal(fixture.creations.length, 2, 'Verified aliases must not be recreated');
});

test('alias creation skips embeddings, remote models and genuine shorter limits', async () => {
  const fixture = ollamaFixture({ 'embed:latest': { capabilities: ['embedding'] }, 'small:latest': show(16384, 16384), 'cloud:latest': { ...show(), remote_host: 'example' } });
  const result = await configureAliases({ baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl });
  assert.equal(result.skipped.length, 3); assert.equal(fixture.creations.length, 0);
});

test('alias verification fails if the inherited tool template changes', async () => {
  const fixture = ollamaFixture({ 'gemma4:e4b-it-qat': show() });
  const fetchImpl = async (url, opts) => {
    const response = await fixture.fetchImpl(url, opts);
    if (url.endsWith('/create')) fixture.map.get('gemma4:e4b-it-qat-32k').template = 'incorrect template';
    return response;
  };
  await assert.rejects(configureAliases({ baseUrl: 'http://fixture', fetchImpl }), /template changed/);
});

test('catalog caps apply after overrides without losing providers, auth or vision', () => {
  const config = { extra: 'preserve', providers: { google: { apiKey: '${GOOGLE_API_KEY}', headers: { Custom: '${TOKEN}' }, models: [{ id: 'large', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'] }], modelOverrides: { large: { contextWindow: 65536, name: 'Custom label' } } } } };
  const result = capConfiguration(config, [{ provider: 'google', id: 'large', contextWindow: 1048576, maxTokens: 65536 }]);
  assert.equal(result.providers.google.apiKey, '${GOOGLE_API_KEY}');
  assert.equal(result.providers.google.modelOverrides.large.contextWindow, 32768);
  assert.deepEqual(result.providers.google.models[0].input, ['text', 'image']);
  assert.equal(config.providers.google.models[0].contextWindow, 1048576, 'Do not mutate caller state');
});

test('live sync hides verified legacy aliases and preserves provider secrets and metadata', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'models.json');
  await fs.writeFile(file, JSON.stringify({ providers: { google: { apiKey: '${GOOGLE_API_KEY}', models: [{ id: 'gemini', contextWindow: 1000000, maxTokens: 65536 }] }, ollama: { headers: { Custom: '${TOKEN}' }, modelOverrides: { 'gemma4:e4b-it-qat-32k': { contextWindow: 65536, name: 'Wrong 64K label' } } } } }));
  const fixture = ollamaFixture({ 'gemma4:e4b-it-qat': show(), 'gemma4:e4b-it-qat-64k': show(), 'gemma4:e4b-it-qat-32k': show(32768), 'nemotron-64k:latest': show(), 'nemotron:latest-32k': show(32768), 'embed:latest': { capabilities: ['embedding'] } });
  const result = await syncModels({ env: { PI_MODELS_FILE: file, PI_OLLAMA_DISCOVERY_RETRY_SECONDS: '0', PI_MODELS_FALLBACK: path.join(temp, 'missing'), PI_MODELS_OVERRIDES: path.join(temp, 'missing') }, fetchImpl: fixture.fetchImpl });
  assert.deepEqual(result.providers.ollama.models.map(m => m.id), ['gemma4:e4b-it-qat-32k', 'nemotron:latest-32k']);
  assert.equal(result.providers.google.models[0].contextWindow, 32768);
  assert.equal(result.providers.google.apiKey, '${GOOGLE_API_KEY}');
  assert.equal(result.providers.ollama.modelOverrides['gemma4:e4b-it-qat-32k'].contextWindow, 32768);
  assert.match(result.providers.ollama.modelOverrides['gemma4:e4b-it-qat-32k'].name, /\[32K\]$/);
  assert.equal(result.providers.ollama.models[0].reasoning, true);
  assert.deepEqual(result.providers.ollama.models[0].input, ['text', 'image']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('offline sync still caps every cached provider; corrupt catalogs are preserved', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-offline-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'models.json');
  const env = { PI_MODELS_FILE: file, PI_OLLAMA_DISCOVERY_RETRY_SECONDS: '0', PI_MODELS_FALLBACK: path.join(temp, 'missing'), PI_MODELS_OVERRIDES: path.join(temp, 'missing') };
  await fs.writeFile(file, JSON.stringify({ providers: { ollama: { apiKey: 'ollama', models: [{ id: 'cached', contextWindow: 65536, maxTokens: 8192 }] }, private: { apiKey: '${SECRET}', models: [{ id: 'small', contextWindow: 16384, maxTokens: 8192 }] } } }));
  const result = await syncModels({ env, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.providers.ollama.models[0].contextWindow, 32768);
  assert.equal(result.providers.private.models[0].contextWindow, 16384);
  assert.equal(result.providers.private.apiKey, '${SECRET}');
  await fs.writeFile(file, '{broken');
  await assert.rejects(syncModels({ env, fetchImpl: async () => { throw new Error('offline'); } }));
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('Web UI alias migration changes selections while preserving transcripts and credentials', () => {
  const old = 'ollama/gemma4:e4b-it-qat-64k', target = 'gemma4:e4b-it-qat-32k';
  const state = { __settings__: { defaultModel: old, projectModels: { '/workspace': old }, defaultProviderKeys: { ollama: old }, settings: { visionBridgeModel: old, customSystemPrompt: old } }, tab: { projectModels: { '/workspace': old }, providerKeys: { key: old }, transcript: [old] } };
  const result = migrateModelSelections(state, { [old.slice(7)]: target }, new Set([target]));
  assert.equal(result.__settings__.defaultModel, `ollama/${target}`);
  assert.equal(result.tab.projectModels['/workspace'], `ollama/${target}`);
  assert.equal(result.__settings__.settings.customSystemPrompt, old);
  assert.deepEqual(result.tab.transcript, [old]); assert.equal(result.tab.providerKeys.key, old);
  assert.equal(result.__settings__.defaultProviderKeys.ollama, old);
});

test('compaction leaves usable recent history and headroom at 32K and smaller native limits', () => {
  assert.deepEqual(compactionFor(32768), { reserveTokens: 8192, keepRecentTokens: 4096 });
  assert.deepEqual(compactionFor(16384), { reserveTokens: 8192, keepRecentTokens: 4096 });
  assert(compactionFor(4096).keepRecentTokens < 4096 - compactionFor(4096).reserveTokens);
});


test('24K Web UI compaction and cache-stable harness contract', async () => {
  const configRoot = process.env.PI_DEFAULT_CONFIG_DIR || path.join(root, 'config');
  const settings = JSON.parse(await fs.readFile(path.join(configRoot, 'settings.json'), 'utf8'));
  const web = JSON.parse(await fs.readFile(path.join(configRoot, 'web-settings.json'), 'utf8'));
  const models = JSON.parse(await fs.readFile(path.join(configRoot, 'models-overrides.json'), 'utf8')).models;
  const prompt = await fs.readFile(path.join(configRoot, 'APPEND_SYSTEM.md'), 'utf8');
  assert.equal(settings.compaction.reserveTokens, 8192);
  assert.equal(settings.compaction.keepRecentTokens, 4096);
  assert.equal(web.softCapTokens, 24576);
  assert.equal(32768 - settings.compaction.reserveTokens, 24576);
  assert(Buffer.byteLength(prompt) <= 4096, 'Prompt must fit standing-prefix budget');
  for (const name of ['tool_search', 'tool_invoke', 'result_get', 'result_list']) assert(prompt.includes(name));
  assert.match(prompt, /discovery grants survive cache eviction/i);
  assert.match(prompt, /schema cache holds nine entries/i);
  for (const id of ['qwen3.5:4b-32k', 'tobestyledintro/qwen3.8-9b-distill:latest-32k']) {
    assert.equal(models[id].samplingParams.temperature, 0.6);
    assert.equal(models[id].samplingParams.top_p, 0.95);
    assert.equal(models[id].contextWindow, 32768);
    assert.equal(models[id].maxTokens, 4096);
  }
});
