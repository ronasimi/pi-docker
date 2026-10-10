import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = process.env.PI_TEST_SCRIPTS_DIR || path.join(root, 'scripts');
const atomicPath = process.env.PI_ATOMIC_EXTENSION_PATH || path.join(root, 'extensions/pi-atomic-tool-results');
const { QWEN_MODELS, QWEN_PARAMETERS, qwenDefinition, qwenProfile, prepareQwen } = await import(pathToFileURL(path.join(scripts, 'prepare-qwen-trial.mjs')));
const { probeQwen } = await import(pathToFileURL(path.join(scripts, 'probe-qwen-trial.mjs')));
const { inspectOllamaRuntime } = await import(pathToFileURL(path.join(scripts, 'inspect-ollama-runtime.mjs')));
const { syncModels } = await import(pathToFileURL(path.join(scripts, 'sync-ollama-models.mjs')));
const { loadSdk } = await import(pathToFileURL(path.join(scripts, 'config-common.mjs')));
const sdk = await loadSdk();
const { default: atomicFactory } = await import(pathToFileURL(path.join(atomicPath, 'index.js')));
const quiet = () => {};
const show = key => ({ capabilities: ['completion', 'tools', 'thinking', 'vision'], thinking: { values: [false, true], default: true },
  model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 },
  template: `native-${key}-template`, parser: `native-${key}-parser`, renderer: `native-${key}-renderer`, system: '', modelfile: `FROM /weights/${key}.gguf` });
const parameters = values => Object.entries(values).map(([key, value]) => `${key} ${value}`).join('\n');

function ollamaFixture({ installed = true, pullError, tamper } = {}) {
  const models = new Map(installed ? Object.keys(QWEN_MODELS).map(key => [qwenDefinition(key).source, show(key)]) : []);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url).pathname.split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ endpoint, body });
    if (endpoint === 'version') return Response.json({ version: 'fixture' });
    if (endpoint === 'tags') return Response.json({ models: [...models.keys()].map(name => ({ name, digest: `sha256:${name}` })) });
    if (endpoint === 'show') return models.has(body.model) ? Response.json(models.get(body.model)) : new Response('', { status: 404 });
    if (endpoint === 'pull') {
      const key = Object.keys(QWEN_MODELS).find(key => QWEN_MODELS[key].source === body.model);
      if (!pullError) models.set(body.model, show(key));
      const lines = JSON.stringify({ status: 'pulling', completed: 5, total: 10 }) + '\n' + JSON.stringify(pullError ? { error: pullError } : { status: 'success' });
      return new Response(new ReadableStream({ start(controller) {
        // Exercise a status object split over chunks and the final missing LF.
        controller.enqueue(new TextEncoder().encode(lines.slice(0, 23)));
        controller.enqueue(new TextEncoder().encode(lines.slice(23)));
        controller.close();
      } }));
    }
    if (endpoint === 'create') {
      const value = { ...structuredClone(models.get(body.from)), parameters: parameters(body.parameters) };
      if (tamper) tamper(value);
      models.set(body.model, value);
      return Response.json({ status: 'success' });
    }
    throw new Error('Unexpected Ollama endpoint: ' + endpoint);
  };
  return { models, calls, fetchImpl };
}

test('both Qwen aliases inherit their own native templates/parsers and retain identical context/output budgets', async () => {
  const fixture = ollamaFixture();
  for (const key of Object.keys(QWEN_MODELS)) {
    const definition = qwenDefinition(key);
    const receipt = await prepareQwen({ key, baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl, log: quiet });
    assert.equal(receipt.model, key === '4b' ? 'qwen3.5:4b-32k' : 'tobestyledintro/qwen3.8-9b-distill:latest-32k');
    assert.equal(receipt.profile.contextWindow, 32768); assert.equal(receipt.profile.maxTokens, 4096);
    assert.equal(fixture.models.get(definition.model).template, show(key).template);
    assert.equal(fixture.models.get(definition.model).parser, show(key).parser);
    const create = fixture.calls.find(call => call.endpoint === 'create' && call.body.model === definition.model).body;
    assert.equal(create.from, definition.source);
    assert.deepEqual(Object.keys(create).sort(), ['from', 'model', 'parameters', 'stream']);
    assert.deepEqual(create.parameters, QWEN_PARAMETERS);
    assert.equal(receipt.profile.compat.thinkingFormat, 'openai');
    assert.equal(receipt.profile.thinkingLevelMap.off, 'none');
    await prepareQwen({ key, baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl, log: quiet });
  }
  assert.equal(fixture.calls.filter(call => call.endpoint === 'create').length, 2, 'Verified aliases must be idempotent');
});

test('Qwen pull consumes split NDJSON, requires success, and never creates an alias after a failed pull', async () => {
  const fixture = ollamaFixture({ installed: false });
  await prepareQwen({ key: '4b', baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl, log: quiet });
  assert.equal(fixture.calls.filter(call => call.endpoint === 'pull').length, 1);
  const failed = ollamaFixture({ installed: false, pullError: 'fixture disk full' });
  await assert.rejects(prepareQwen({ key: 'distill', baseUrl: 'http://fixture', fetchImpl: failed.fetchImpl, log: quiet }), /disk full/);
  assert(!failed.calls.some(call => call.endpoint === 'create'));
});

test('Qwen preparation rejects missing capabilities, unsupported thinking-off, remote models and corrupted templates', async () => {
  assert.throws(() => qwenProfile({ ...show('4b'), capabilities: ['completion'] }), /tools capability/);
  assert.throws(() => qwenProfile({ ...show('4b'), thinking: { values: [true] } }), /thinking off/);
  assert.throws(() => qwenProfile({ ...show('4b'), remote_host: 'cloud' }), /local model/);
  const fixture = ollamaFixture({ tamper: value => { value.parser = 'incorrect'; } });
  await assert.rejects(prepareQwen({ baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl, log: quiet }), /template.*parser/);
});

test('Qwen named thinking metadata is mapped without sending llama.cpp chat-template flags', () => {
  const profile = qwenProfile({ ...show('4b'), thinking: { values: [false, 'balanced', 'extended'], default: 'balanced' } });
  assert.equal(profile.thinkingLevelMap.off, 'none');
  assert.equal(profile.thinkingLevelMap.medium, 'balanced');
  assert.equal(profile.thinkingLevelMap.high, 'extended');
  assert.equal(profile.compat.thinkingFormat, 'openai');
});

test('synchronization exposes both aliases in the actual SDK and replaces stale compatibility overrides', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-sync-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const fixture = ollamaFixture();
  const overrides = { models: {} }, masked = {};
  for (const key of Object.keys(QWEN_MODELS)) {
    const receipt = await prepareQwen({ key, baseUrl: 'http://fixture', fetchImpl: fixture.fetchImpl, log: quiet });
    overrides.models[receipt.model] = receipt.profile;
    masked[receipt.model] = { compat: { thinkingFormat: 'qwen-chat-template' }, samplingParams: { top_k: 200, temperature: 99 }, contextWindow: 64000 };
  }
  const catalogPath = path.join(temp, 'models.json'), overridesPath = path.join(temp, 'overrides.json');
  await fs.writeFile(catalogPath, JSON.stringify({ providers: { ollama: { modelOverrides: masked }, private: { api: 'openai-completions', baseUrl: 'http://localhost:1/v1', apiKey: '${UNCHANGED}', models: [{ id: 'custom', contextWindow: 64000 }] } } }));
  await fs.writeFile(overridesPath, JSON.stringify(overrides));
  const result = await syncModels({ env: { PI_MODELS_FILE: catalogPath, PI_MODELS_OVERRIDES: overridesPath, PI_MODELS_FALLBACK: path.join(temp, 'missing'), PI_OLLAMA_DISCOVERY_RETRY_SECONDS: '0', OLLAMA_BASE_URL: 'http://fixture' }, fetchImpl: fixture.fetchImpl });
  assert.equal(result.providers.private.apiKey, '${UNCHANGED}');
  assert.deepEqual(result.providers.ollama.models.map(m => m.id).sort(), Object.keys(overrides.models).sort());
  const runtime = await sdk.ModelRuntime.create({ modelsPath: catalogPath, refreshOnCreate: false }); assert(!runtime.getError(), runtime.getError());
  for (const key of Object.keys(QWEN_MODELS)) {
    const model = runtime.getModel('ollama', qwenDefinition(key).model);
    assert.equal(model.compat.thinkingFormat, 'openai');
    assert.equal(model.thinkingLevelMap.off, 'none');
    assert.equal(model.samplingParams.top_k, undefined);
    assert.equal(model.contextWindow, 32768); assert.equal(model.maxTokens, 4096);
    assert.deepEqual(model.input, ['text', 'image']);
  }
});

async function providerFixture(t, key, { rawThinking = false, staleOperation = false, runtimeContext = 32768 } = {}) {
  const requests = [];
  const nativeCalls = [];
  const digest = `fixture:${key}`;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: qwenDefinition(key).model, digest }] }));
        return;
      }
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: qwenDefinition(key).model, digest, context_length: runtimeContext, size: 4000, size_vram: 3000 }] }));
        return;
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      if (req.url === '/api/show' || req.url === '/api/generate') {
        const body = JSON.parse(Buffer.concat(chunks).toString()); nativeCalls.push({ endpoint: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/show' ? { ...show(key), parameters: parameters(QWEN_PARAMETERS) } : { done: true }));
        return;
      }
      const request = JSON.parse(Buffer.concat(chunks).toString()); requests.push(request);
      const stage = (requests.length - 1) % 4;
      const toolJson = request.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
      const user = request.messages.findLast(m => m.role === 'user' && /query "[^"]+"/.test(typeof m.content === 'string' ? m.content : m.content.map(part=>part.text||'').join('\n')));
      const content = typeof user.content === 'string' ? user.content : user.content.map(part => part.text || '').join('\n');
      const name = /query "([^"]+)"/.exec(content)[1];
      let call, final;
      if (stage === 0) call = { name: 'tool_search', arguments: { query: name } };
      if (stage === 1) {
        const args = JSON.parse(/arguments (\{[^}]+\})\./.exec(content)[1]);
        call = { name: 'tool_invoke', arguments: { name: staleOperation && name === 'trial_echo_2' ? 'trial_echo_1' : name, arguments: args } };
      }
      if (stage === 2) call = { name: 'result_get', arguments: { result_ref: toolJson.findLast(j => j.atomic_result).atomic_result.ref, selector: 'json.receipt.confirmation', max_chars: 1024 } };
      if (stage === 3) final = (rawThinking ? '<think>leaked</think>' : '') + 'Verified ' + toolJson.findLast(j => j.selector === 'json.receipt.confirmation').value;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: `qwen-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: qwenDefinition(key).model };
      const send = delta => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (request.reasoning_effort !== 'none') send({ role: 'assistant', reasoning: 'Use the exact discovered schema and retrieve the archived proof.' });
      send(call ? { role: 'assistant', tool_calls: [{ index: 0, id: `qwen-call-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: 'assistant', content: final });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const model = { ...qwenProfile(show(key), key), id: qwenDefinition(key).model, provider: 'ollama', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  return { model, requests, digest, nativeCalls, show: { ...show(key), parameters: parameters(QWEN_PARAMETERS) } };
}

for (const key of Object.keys(QWEN_MODELS)) test(`real Pi SDK ${key}: thinking off/on, exact structured discovery/invocation/retrieval and stable standing prefix`, { timeout: 30000 }, async t => {
  const fixture = await providerFixture(t, key);
  const report = await probeQwen({ sdk, atomicFactory, ...fixture, timeoutMs: 10000, log: quiet });
  assert.equal(report.status, 'passed'); assert.equal(report.contextWindow, 32768); assert.equal(report.compactionThreshold, 24576);
  assert.equal(report.version, 2); assert.equal(report.roundsPerMode, 2);
  assert.deepEqual(report.cases.map(c => [c.thinkingLevel, c.providerRequests, c.toolExecutions, c.evidenceRetrievals, c.separatedThinking]), [['off', 8, 2, 2, false], ['medium', 8, 2, 2, true]]);
  assert(report.cases.every(c => c.runtime.contextWindow === 32768 && c.runtime.digest === fixture.digest));
  assert(report.cases.every(c => c.maxSchemaCount >= 1 && c.maxSchemaCount <= c.rounds.length && c.maxSchemasPerDiscovery === 1 && c.maxBufferedTools >= 1 && c.maxBufferedTools <= 9 && c.stableDeclarations && c.immutableToolResults));
  assert(report.cases.every(c => c.rounds.every(turn => turn.peakRequestBytes > 0 && turn.reportedPromptTokens === 100)));
  assert(report.cases.every(c => c.firstTokenMs !== null));
  assert.equal(fixture.requests.length, 16);
});

test('real Pi SDK probe rejects raw reasoning tags instead of permitting activation', { timeout: 30000 }, async t => {
  const fixture = await providerFixture(t, '4b', { rawThinking: true });
  await assert.rejects(probeQwen({ sdk, atomicFactory, ...fixture, timeoutMs: 10000, log: quiet }), /Raw reasoning/);
});

test('real Pi SDK sustained trial keeps eight different schemas bounded across 64 requests', { timeout: 30000 }, async t => {
  const fixture = await providerFixture(t, '4b');
  const report = await probeQwen({ sdk, atomicFactory, ...fixture, rounds: 8, timeoutMs: 10000, log: quiet });
  assert.equal(fixture.requests.length, 64);
  assert(report.cases.every(c => c.rounds.length === 8 && c.toolExecutions === 8 && c.evidenceRetrievals === 8 && c.maxSchemaCount >= 1 && c.maxSchemaCount <= 8 && c.maxSchemasPerDiscovery === 1 && c.maxBufferedTools === 8 && c.stableDeclarations && c.immutableToolResults));
});

test('real Pi SDK rejects a previous-turn tool and a smaller loaded context', { timeout: 30000 }, async t => {
  const stale = await providerFixture(t, '4b', { staleOperation: true });
  await assert.rejects(probeQwen({ sdk, atomicFactory, ...stale, timeoutMs: 10000, log: quiet }), error => {
    assert.match(error.message, /exact structured invocation/);
    assert.equal(error.trialReport.status, 'failed');
    assert.equal(error.trialReport.failure.thinkingLevel, 'off');
    assert.equal(error.trialReport.failure.turn, 2); assert.equal(error.trialReport.failure.completedTurns, 1);
    assert.equal(error.trialReport.failure.rounds[0].status, 'passed');
    return true;
  });
  const small = await providerFixture(t, 'distill', { runtimeContext: 16384 });
  await assert.rejects(probeQwen({ sdk, atomicFactory, ...small, timeoutMs: 10000, log: quiet }), error => {
    assert.match(error.message, /Loaded Ollama context differs/);
    assert.equal(error.trialReport.failure.phase, 'loaded_context');
    assert.equal(error.trialReport.failure.completedTurns, 2);
    return true;
  });
});

test('running-context inspection rejects missing models, missing allocation and changed digests', async () => {
  const model = qwenDefinition('4b').model;
  const inspect = data => inspectOllamaRuntime({ baseUrl: 'http://fixture/v1', model, digest: 'expected', fetchImpl: async url => {
    assert.equal(url, 'http://fixture/api/ps'); return Response.json(data);
  } });
  await assert.rejects(inspect({ models: [] }), /absent/);
  await assert.rejects(inspect({ models: [{ name: model, digest: 'expected' }] }), /context differs/);
  await assert.rejects(inspect({ models: [{ name: model, digest: 'changed', context_length: 32768 }] }), /digest changed/);
  const runtime = await inspect({ models: [{ model, digest: 'expected', context_length: 32768 }] });
  assert.equal(runtime.contextWindow, 32768); assert.equal(runtime.sizeBytes, null);
});

test('real Pi SDK probe detects rewritten retrieved evidence across follow-up history', { timeout: 30000 }, async t => {
  const fixture = await providerFixture(t, '4b');
  const leakyFactory = pi => {
    atomicFactory(pi);
    let first;
    pi.on('context', event => {
      const hydrated = event.messages.find(message => message.toolName === 'result_get' && message.content?.some(part => {
        try { return Object.hasOwn(JSON.parse(part.text), 'value'); } catch { return false; }
      }));
      if (!first && hydrated) first = structuredClone(hydrated);
      if (first && event.messages.filter(message=>message.toolName==='result_get').length>=2) return { messages: event.messages.map(message => {
        if(message.toolCallId!==first.toolCallId)return message;
        const content=message.content.map(part=>{if(part.type!=='text')return part;try{const data=JSON.parse(part.text);if(Object.hasOwn(data,'value'))return {...part,text:JSON.stringify({...data,value:'forged-observation'})};}catch{}return part;});
        return {...message,content};
      }) };
    });
  };
  await assert.rejects(probeQwen({ sdk, atomicFactory: leakyFactory, ...fixture, timeoutMs: 10000, log: quiet }), /Retrieved confirmation never reached|Retrieved evidence changed/);
});

test('real Pi SDK probe detects rewritten ordinary evidence even when tool declarations stay fixed', { timeout: 30000 }, async t => {
  const fixture = await providerFixture(t, 'distill');
  const mutatingFactory = pi => {
    atomicFactory(pi);
    let n = 0;
    pi.on('context', event => ({ messages: event.messages.map(message => {
      if (message.toolName !== 'tool_invoke') return message;
      return { ...message, content: message.content.map(part => {
        try { const data = JSON.parse(part.text); if (data.atomic_result) { data.atomic_result.unstable = ++n; return { ...part, text: JSON.stringify(data) }; } } catch {}
        return part;
      }) };
    }) }));
  };
  await assert.rejects(probeQwen({ sdk, atomicFactory: mutatingFactory, ...fixture, timeoutMs: 10000, log: quiet }), /Ordinary archived results changed/);
});

test('actual probe CLI persists passed/partial-failed reports and unloads only the trial alias', { timeout: 30000 }, async t => {
  for (const staleOperation of [false, true]) {
    const fixture = await providerFixture(t, '4b', { staleOperation });
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-cli-')); t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
    const definition = qwenDefinition('4b'), trialDir = path.join(agentDir, 'model-trials/qwen-32k/4b');
    await fs.mkdir(trialDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { ollama: { api: fixture.model.api, baseUrl: fixture.model.baseUrl, apiKey: 'ollama', models: [fixture.model] } } }));
    await fs.writeFile(path.join(trialDir, 'prepared.json'), JSON.stringify({ model: definition.model, digest: fixture.digest, ollamaVersion: 'fixture' }));
    await fs.writeFile(path.join(trialDir, 'probe.json'), JSON.stringify({ status: 'passed', version: 1 }));
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'gemma4:e4b-it-qat-32k' }));
    const before = await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8');
    const child = spawn(process.execPath, [path.join(scripts, 'probe-qwen-trial.mjs'), '4b'], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_ATOMIC_EXTENSION_PATH: atomicPath, PI_QWEN_PROBE_ROUNDS: '2', PI_QWEN_PROBE_TIMEOUT_MS: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const report = JSON.parse(await fs.readFile(path.join(trialDir, 'probe.json'), 'utf8'));
    assert.equal(code, staleOperation ? 1 : 0, stderr);
    assert.equal(report.version, 2); assert.equal(report.key, '4b'); assert.equal(report.digest, fixture.digest);
    assert.equal(report.status, staleOperation ? 'failed' : 'passed');
    if (staleOperation) { assert.equal(report.failure.turn, 2); assert.equal(report.failure.completedTurns, 1); }
    else { assert.equal(JSON.parse(stdout).status, 'passed'); assert.equal(report.cases.length, 2); }
    assert.deepEqual(fixture.nativeCalls.filter(call => call.endpoint === '/api/generate').map(call => call.body), [{ model: definition.model, keep_alive: 0, stream: false }]);
    assert.equal(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'), before);
  }
});

function passedReport(key, receipt) {
  return { version: 2, status: 'passed', model: receipt.model, digest: receipt.digest, testedProfile: structuredClone(receipt.profile), roundsPerMode: 2, contextWindow: 32768, maxTokens: 4096, compactionThreshold: 24576, checkedAt: new Date().toISOString(),
    cases: ['off', 'medium'].map(thinkingLevel => ({ thinkingLevel, status: 'passed', toolExecutions: 2, evidenceRetrievals: 2, stableDeclarations: true, immutableToolResults: true, maxSchemaCount: 2, maxSchemasPerDiscovery: 1, maxBufferedTools: 2,
      runtime: { status: 'passed', model: receipt.model, contextWindow: 32768, digest: receipt.digest },
      rounds: [1, 2].map(turn => ({ status: 'passed', toolName: `trial_echo_${turn}`, toolExecutions: 1, evidenceRetrievals: 1, separatedThinking: thinkingLevel !== 'off' })) })) };
}

async function selectionFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-select-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const write = async (file, data) => { await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true }); await fs.writeFile(path.join(temp, file), JSON.stringify(data)); };
  await fs.writeFile(path.join(temp, 'compose.yaml'), 'services: {}\n');
  const gemma = 'ollama/gemma4:e4b-it-qat-32k';
  await write('config/models-overrides.json', { models: { unrelated: { custom: true } } });
  await write('data/pi/agent/models.json', { providers: { ollama: { models: Object.keys(QWEN_MODELS).map(key => ({ ...qwenProfile(show(key), key), id: qwenDefinition(key).model })) } } });
  await write('data/pi/agent/settings.json', { defaultProvider: 'ollama', defaultModel: gemma.slice(7), compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4096 } });
  await write('data/web/client-state.json', { __settings__: { defaultModel: gemma, projectModels: { '/workspace': gemma, '/other': 'private/custom' }, defaultProviderKeys: { private: 'keep' }, settings: { softCapTokens: 24576, toolApprovalEnabled: true } }, tab: { projectModels: { '/workspace': gemma }, transcript: ['preserve'] } });
  const receipts = {};
  for (const key of Object.keys(QWEN_MODELS)) {
    receipts[key] = { version: 1, key, source: qwenDefinition(key).source, model: qwenDefinition(key).model, digest: `sha256:${key}`, profile: qwenProfile(show(key), key), preparedAt: new Date().toISOString() };
    await write(`data/pi/agent/model-trials/qwen-32k/${key}/probe.json`, passedReport(key, receipts[key]));
  }
  const helper = (mode, key = '4b', input = receipts[key]) => spawnSync('python3', [path.join(scripts, 'configure-qwen-trial.py'), mode, temp, key], { encoding: 'utf8', input: JSON.stringify(input) });
  const read = async file => JSON.parse(await fs.readFile(path.join(temp, file)));
  return { temp, write, read, helper, receipts, gemma };
}

test('selection helper adds both profiles without changing defaults and restores the original selections across multiple Qwen switches', async t => {
  const fixture = await selectionFixture(t);
  const originals = await fixture.read('data/web/client-state.json');
  for (const key of ['4b', 'distill']) {
    const stored = fixture.helper('profile', key); assert.equal(stored.status, 0, stored.stderr);
  }
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  assert.deepEqual(await fixture.read('data/web/client-state.json'), originals);
  for (const key of ['4b', '4b', 'distill']) {
    const activation = fixture.helper('activate', key); assert.equal(activation.status, 0, activation.stderr);
    const state = await fixture.read('data/web/client-state.json');
    assert.equal(state.__settings__.projectModels['/workspace'], 'ollama/' + qwenDefinition(key).model);
    assert.equal(state.__settings__.projectModels['/other'], 'private/custom');
    assert.deepEqual(state.tab.transcript, ['preserve']);
  }
  const restored = fixture.helper('restore'); assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(await fixture.read('data/web/client-state.json'), originals);
  const settings = await fixture.read('data/pi/agent/settings.json');
  assert.equal(settings.defaultModel, fixture.gemma.slice(7));
  assert.deepEqual(settings.compaction, { enabled: true, reserveTokens: 8192, keepRecentTokens: 4096 });
  assert.equal(settings.modelThinkingLevels, undefined);
  assert((await fixture.read('config/models-overrides.json')).models.unrelated.custom);
});

test('activation rejects failed, stale and mismatched probes; restore preserves subsequent manual choices and credentials', async t => {
  const fixture = await selectionFixture(t); assert.equal(fixture.helper('profile').status, 0);
  const file = 'data/pi/agent/model-trials/qwen-32k/4b/probe.json', valid = await fixture.read(file);
  for (const report of [{ ...valid, status: 'failed' }, { ...valid, checkedAt: '2000-01-01T00:00:00Z' }, { ...valid, digest: 'changed' }]) {
    await fixture.write(file, report);
    assert.equal(fixture.helper('activate').status, 1);
    assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  }
  await fixture.write(file, valid); assert.equal(fixture.helper('activate').status, 0);
  const state = await fixture.read('data/web/client-state.json');
  state.__settings__.defaultModel = 'private/manual';
  state.__settings__.defaultProviderKeys.private = 'new-key';
  state.tab.transcript.push('new-message');
  await fixture.write('data/web/client-state.json', state);
  const result = fixture.helper('restore'); assert.equal(result.status, 0, result.stderr);
  assert(JSON.parse(result.stdout).keptManualChanges > 0);
  const restored = await fixture.read('data/web/client-state.json');
  assert.equal(restored.__settings__.defaultModel, 'private/manual');
  assert.equal(restored.__settings__.defaultProviderKeys.private, 'new-key');
  assert.deepEqual(restored.tab.transcript, ['preserve', 'new-message']);
});

test('profile persistence rejects wrong budgets before modifying configuration', async t => {
  const fixture = await selectionFixture(t);
  const original = await fixture.read('config/models-overrides.json');
  const receipt = structuredClone(fixture.receipts['4b']); receipt.profile.contextWindow = 131072;
  assert.equal(fixture.helper('profile', '4b', receipt).status, 1);
  assert.deepEqual(await fixture.read('config/models-overrides.json'), original);
});

test('activation rejects old reports, incomplete follow-ups, unverified loaded contexts and profiles changed after testing', async t => {
  const fixture = await selectionFixture(t); assert.equal(fixture.helper('profile').status, 0);
  const file = 'data/pi/agent/model-trials/qwen-32k/4b/probe.json', valid = await fixture.read(file);
  const old = { ...valid, version: 1 };
  const incomplete = structuredClone(valid); incomplete.cases[0].rounds.pop();
  const small = structuredClone(valid); small.cases[0].runtime.contextWindow = 16384;
  const different = structuredClone(valid); different.cases[0].runtime.digest = 'different';
  const mutable = structuredClone(valid); mutable.cases[0].immutableToolResults = false;
  const tooManyHistorical = structuredClone(valid); tooManyHistorical.cases[0].maxSchemaCount = 3;
  const multiSchemaDiscovery = structuredClone(valid); multiSchemaDiscovery.cases[0].maxSchemasPerDiscovery = 2;
  const overflowingLease = structuredClone(valid); overflowingLease.cases[0].maxBufferedTools = 10;
  const missingLeaseEvidence = structuredClone(valid); delete missingLeaseEvidence.cases[0].maxBufferedTools;
  for (const report of [old, incomplete, small, different, mutable, tooManyHistorical, multiSchemaDiscovery, overflowingLease, missingLeaseEvidence]) {
    await fixture.write(file, report); const result = fixture.helper('activate'); assert.equal(result.status, 1);
    assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
    assert.equal((await fixture.read('data/web/client-state.json')).__settings__.defaultModel, fixture.gemma);
  }
  await fixture.write(file, valid);
  const catalog = await fixture.read('data/pi/agent/models.json');
  const originalCatalog = structuredClone(catalog);
  catalog.providers.ollama.models[0].compat.thinkingFormat = 'qwen-chat-template';
  await fixture.write('data/pi/agent/models.json', catalog);
  const changed = fixture.helper('activate'); assert.equal(changed.status, 1); assert.match(changed.stderr, /profile changed.*compat/);
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  await fixture.write('data/pi/agent/models.json', originalCatalog);
  const overrides = await fixture.read('config/models-overrides.json');
  overrides.models[qwenDefinition('4b').model].samplingParams.temperature = 1.7;
  await fixture.write('config/models-overrides.json', overrides);
  const sourceChanged = fixture.helper('activate'); assert.equal(sourceChanged.status, 1); assert.match(sourceChanged.stderr, /profile changed.*samplingParams/);
  assert.equal((await fixture.read('data/web/client-state.json')).__settings__.defaultModel, fixture.gemma);
});

test('activation preserves compatibility metadata that was actually tested and rejects a pending change to it', async t => {
  const fixture = await selectionFixture(t); assert.equal(fixture.helper('profile').status, 0);
  const catalog = await fixture.read('data/pi/agent/models.json');
  catalog.providers.ollama.compat = { supportsDeveloperRole: false };
  catalog.providers.ollama.models[0].compat.supportsStore = false;
  await fixture.write('data/pi/agent/models.json', catalog);
  const file = 'data/pi/agent/model-trials/qwen-32k/4b/probe.json', report = await fixture.read(file);
  report.testedProfile.compat.supportsStore = false;
  await fixture.write(file, report);
  const activated = fixture.helper('activate'); assert.equal(activated.status, 0, activated.stderr);
  assert.equal((await fixture.read('data/pi/agent/models.json')).providers.ollama.models[0].compat.supportsStore, false);
  assert.equal(fixture.helper('restore').status, 0);
  const overrides = await fixture.read('config/models-overrides.json');
  for (const value of [true, 0]) {
    overrides.models[qwenDefinition('4b').model].compat.supportsStore = value;
    await fixture.write('config/models-overrides.json', overrides);
    const changed = fixture.helper('activate'); assert.equal(changed.status, 1); assert.match(changed.stderr, /profile changed.*compat/);
    assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  }
});

async function hostFixture(t) {
  const fixture = await selectionFixture(t);
  const bin = path.join(fixture.temp, 'bin'), installed = path.join(fixture.temp, 'scripts');
  await fs.mkdir(bin); await fs.mkdir(installed);
  for (const file of ['setup-qwen.sh', 'configure-qwen-trial.py']) await fs.copyFile(path.join(scripts, file), path.join(installed, file));
  await fs.writeFile(path.join(installed, 'validate-image.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const reports = Object.fromEntries(Object.entries(fixture.receipts).map(([key, receipt]) => [key, passedReport(key, receipt)]));
  await fixture.write('mock.json', { receipts: fixture.receipts, reports });
  await fs.writeFile(path.join(bin, 'docker'), `#!/usr/bin/env python3
import datetime, json, pathlib, sys
root = pathlib.Path.cwd()
mock = json.loads((root / 'mock.json').read_text())
args = sys.argv[1:]
command = next((name for name in ['prepare-qwen-trial.mjs', 'probe-qwen-trial.mjs'] if any(arg.endswith('/' + name) for arg in args)), args[1])
key = args[-1] if command.endswith('.mjs') else None
with (root / 'docker-calls.jsonl').open('a') as stream:
    stream.write(json.dumps({'command': command, 'key': key}) + '\\n')
if command == 'prepare-qwen-trial.mjs':
    if key == mock.get('failPrepare'): sys.exit(1)
    print(json.dumps(mock['receipts'][key]))
elif command == 'probe-qwen-trial.mjs':
    report = root / 'data/pi/agent/model-trials/qwen-32k' / key / 'probe.json'
    if key == mock.get('failProbe'):
        report.write_text(json.dumps({'status': 'failed'}))
        sys.exit(1)
    receipt = mock['receipts'][key]
    passed = mock['reports'][key]
    passed['checkedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report.write_text(json.dumps(passed))
`);
  await fs.chmod(path.join(bin, 'docker'), 0o755);
  const run = (selector, mode, env = {}) => spawnSync('bash', [path.join(installed, 'setup-qwen.sh'), selector, mode], { encoding: 'utf8', env: { ...process.env, ...env, PATH: bin + path.delimiter + process.env.PATH } });
  const calls = async () => (await fs.readFile(path.join(fixture.temp, 'docker-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { ...fixture, run, calls, reports };
}

test('host rejects invalid trial settings before Docker operations or pulling model weights', async t => {
  const fixture = await hostFixture(t);
  for (const env of [{ PI_QWEN_PROBE_ROUNDS: '1' }, { PI_QWEN_PROBE_ROUNDS: '13' }, { PI_QWEN_PROBE_TIMEOUT_MS: 'invalid' }]) {
    const result = fixture.run('all', '--add', env); assert.equal(result.status, 1); assert.match(result.stderr, /must be an integer/);
  }
  await assert.rejects(fs.access(path.join(fixture.temp, 'docker-calls.jsonl')), { code: 'ENOENT' });
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
});

test('host setup continues the second candidate after a failed pull and leaves both defaults unchanged', async t => {
  const fixture = await hostFixture(t);
  await fixture.write('mock.json', { receipts: fixture.receipts, reports: fixture.reports, failPrepare: '4b' });
  const result = fixture.run('all', '--add'); assert.equal(result.status, 1, result.stderr);
  const calls = await fixture.calls();
  assert.deepEqual(calls.filter(c => c.command === 'prepare-qwen-trial.mjs').map(c => c.key), ['4b', 'distill']);
  assert.deepEqual(calls.filter(c => c.command === 'probe-qwen-trial.mjs').map(c => c.key), ['distill']);
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  assert.equal((await fixture.read('data/web/client-state.json')).__settings__.defaultModel, fixture.gemma);
  assert.equal((await fixture.read('config/models-overrides.json')).models[qwenDefinition('4b').model], undefined);
  assert((await fixture.read('config/models-overrides.json')).models[qwenDefinition('distill').model]);
});

test('host activation requires a successful fresh probe and restore recovers both saved selections', async t => {
  const fixture = await hostFixture(t);
  await fixture.write('mock.json', { receipts: fixture.receipts, reports: fixture.reports, failProbe: '4b' });
  const failed = fixture.run('4b', '--activate'); assert.equal(failed.status, 1, failed.stderr);
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  assert.equal((await fixture.read('data/web/client-state.json')).__settings__.defaultModel, fixture.gemma);
  await fixture.write('mock.json', { receipts: fixture.receipts, reports: fixture.reports });
  const activated = fixture.run('4b', '--activate'); assert.equal(activated.status, 0, activated.stderr);
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, qwenDefinition('4b').model);
  assert.equal((await fixture.read('data/web/client-state.json')).__settings__.defaultModel, 'ollama/' + qwenDefinition('4b').model);
  const restored = fixture.run('--restore'); assert.equal(restored.status, 0, restored.stderr);
  assert.equal((await fixture.read('data/pi/agent/settings.json')).defaultModel, fixture.gemma.slice(7));
  assert.equal((await fixture.read('data/web/client-state.json')).__settings__.defaultModel, fixture.gemma);
});
