#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, loadSdk, isMain, integer } from './config-common.mjs';
import { configuredContext, compactionFor } from './model-policy.mjs';
import { qwenDefinition, verifyQwenAlias } from './prepare-qwen-trial.mjs';
import { ACTIVE_TOOLS } from './verify-runtime-session.mjs';
import { inspectOllamaRuntime } from './inspect-ollama-runtime.mjs';

function toolValues(request) {
  return request.messages.filter(message => message.role === 'tool').flatMap(message => {
    try { return [{ id: message.tool_call_id, value: JSON.parse(message.content), content: message.content }]; } catch { return []; }
  });
}

function fullSchemas(request) {
  return toolValues(request).filter(({ value }) => value.discovery === 'ready' && value.tools?.some(tool => tool.parameters)).flatMap(({ value }) => value.tools);
}

// Tool-search messages accumulate in the immutable conversation suffix. This
// historical count is independent of the bounded schema cache and operation
// authorization. Each discovery adds at most one schema; the cache holds nine.
export function schemaBudget(requests) {
  const discoveries = requests.flatMap(request => toolValues(request).filter(({ value }) => ['ready', 'reused'].includes(value.discovery) && Array.isArray(value.tools)));
  const maxSchemasPerDiscovery = Math.max(0, ...discoveries.map(({ value }) => value.tools.length));
  const maxBufferedTools = Math.max(0, ...discoveries.map(({ value }) => Array.isArray(value.buffered) ? value.buffered.length : 0));
  const maxSchemaCount = Math.max(0, ...requests.map(request => fullSchemas(request).length));
  assert(discoveries.every(({ value }) => value.tools.length <= 1), 'More than one schema returned per discovery');
  assert(discoveries.every(({ value }) => Array.isArray(value.buffered) && value.buffered.length <= 9 && new Set(value.buffered).size === value.buffered.length), 'FIFO discovery buffer exceeded nine distinct tools');
  return { maxSchemaCount, maxSchemasPerDiscovery, maxBufferedTools };
}

export async function probeQwen({ sdk, model, atomicFactory, show, digest, rounds = 2, timeoutMs = 600000, fetchImpl = fetch, log = message => console.error(`[qwen] ${message}`) }) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Probe timeout must be a positive integer');
  assert(Number.isSafeInteger(rounds) && rounds >= 2 && rounds <= 12, 'Probe rounds must be between 2 and 12');
  assert.equal(model.contextWindow, 32768); assert.equal(model.maxTokens, 4096);
  assert.equal(configuredContext(show), 32768, 'Ollama must allocate the same context as Pi');
  assert.equal(model.compat.thinkingFormat, 'openai'); assert.equal(model.compat.maxTokensField, 'max_tokens');
  assert.equal(model.thinkingLevelMap.off, 'none');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-qwen-trial-'));
  const cases = [];
  const testedProfile = structuredClone(Object.fromEntries(['name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'compat', 'thinkingLevelMap', 'samplingParams'].map(field => [field, model[field]])));
  const report = status => ({ version: 2, status, model: model.id, digest, testedProfile, roundsPerMode: rounds, contextWindow: 32768, maxTokens: 4096, compactionThreshold: 32768 - compactionFor(32768).reserveTokens, keepRecentTokens: 4096, checkedAt: new Date().toISOString(), cases });
  let progress;
  try {
    for (const level of ['off', 'medium']) {
      log(`Testing ${level}: ${rounds} follow-up turns with different deferred schemas...`);
      const executed = [], requests = [], hookErrors = [], roundReports = [], compactions = [];
      progress = { thinkingLevel: level, phase: 'setup', turn: 0, started: performance.now(), requests, roundReports, compactions, timedOut: false };
      const ordinaryResults = new Map();
      const retrievalResults = new Map();
      const discoveryResults = new Map();
      const operations = Array.from({ length: rounds }, (_, i) => {
        const property = i % 2 ? 'ticket' : 'token';
        return { name: `trial_echo_${i + 1}`, property, expected: randomUUID(), proof: randomUUID(),
          parameters: { type: 'object', properties: { [property]: { type: 'string' } }, required: [property], additionalProperties: false } };
      });
      const runtime = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: 'openai-completions', apiKey: 'ollama', models: [model] });
      const compaction = { enabled: true, ...compactionFor(32768) };
      const services = await sdk.createAgentSessionServices({ cwd: temp, agentDir: temp, modelRuntime: runtime,
        settingsManager: sdk.SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'edit', 'write', 'tool_search'], compaction, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, appendSystemPromptOverride: () => [], extensionFactories: [
          { name: 'trial-tool-search', factory: sdk.createToolSearchExtension() },
          { name: 'trial-atomic', factory: atomicFactory },
          { name: 'trial-echo', factory: pi => {
            for (const operation of operations) pi.registerTool({ name: operation.name, label: operation.name, description: `Verify one exact ${operation.property} using ${operation.name}. Read-only local trial; no external target.`, exposure: 'deferred',
              parameters: operation.parameters,
              async execute(_id, args) { executed.push({ name: operation.name, value: args[operation.property] }); return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', receipt: { confirmation: operation.proof }, padding: 'x'.repeat(5000) }) }], details: {} }; },
            });
            // Model mistakes can be observed without executing a file/shell tool.
            pi.on('tool_call', event => { if (!['tool_search', 'tool_invoke', 'result_get', ...operations.map(operation => operation.name)].includes(event.toolName)) return { block: true, reason: 'This probe only permits discovery and the local trial echo.' }; });
            pi.on('before_provider_request', (event, ctx) => {
              requests.push(structuredClone(event.payload));
              if (requests.length > rounds * 8) { ctx.abort(); throw new Error(`Trial exceeded ${rounds * 8} provider requests`); }
            });
          } },
        ] },
      });
      assert.deepEqual(services.diagnostics, []); assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const { session } = await sdk.createAgentSessionFromServices({ services, model: runtime.getModel(model.provider, model.id), thinkingLevel: level, sessionManager: sdk.SessionManager.inMemory(temp) });
      let timer, currentTurn, timedOut = false; const started = performance.now();
      try {
        await session.bindExtensions({ onError: error => hookErrors.push(error) });
        assert.deepEqual(session.getActiveToolNames().sort(), [...ACTIVE_TOOLS].sort());
        assert.deepEqual(session.settingsManager.getCompactionSettings(session.model), compaction);
        session.subscribe(event => {
          if (currentTurn?.firstTokenMs === null && event.type === 'message_update' && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.assistantMessageEvent?.type)) currentTurn.firstTokenMs = performance.now() - currentTurn.started;
          if (event.type === 'compaction_end') compactions.push({ status: !event.aborted && !event.errorMessage ? 'passed' : 'failed', reason: event.reason, tokensBefore: event.result?.tokensBefore, estimatedTokensAfter: event.result?.estimatedTokensAfter, error: event.errorMessage });
        });
        timer = setTimeout(() => { timedOut = true; progress.timedOut = true; void session.abort(); }, timeoutMs);
        for (const operation of operations) {
          const prior = new Set(session.messages.map(message => JSON.stringify(message)));
          const firstRequest = requests.length, firstExecution = executed.length;
          currentTurn = { started: performance.now(), firstTokenMs: null };
          Object.assign(progress, { phase: 'inference', turn: roundReports.length + 1 });
          const args = { [operation.property]: operation.expected };
          await session.prompt(`Verify one local capability in this turn. First call tool_search with query "${operation.name}" and omit limit. Then emit a real tool_invoke function call with name "${operation.name}" and arguments ${JSON.stringify(args)}. Execute it exactly once. Its receipt is archived: call result_get once using its returned opaque result_ref and selector "json.receipt.confirmation". Finish with a short visible answer containing that exact retrieved confirmation value. Do not reuse a previous turn's tool, arguments or receipt, call another operation, or imitate a tool call as text.`);
          const lastAssistant = session.messages.findLast(message => message.role === 'assistant');
          Object.assign(progress, { phase: 'verification', lastStopReason: lastAssistant?.stopReason, providerError: lastAssistant?.errorMessage });
          assert(!timedOut, `Thinking ${level} probe timed out after ${timeoutMs} ms`);
          assert.deepEqual(hookErrors, [], 'Trial extension hooks failed');
          assert.deepEqual(executed.slice(firstExecution), [{ name: operation.name, value: operation.expected }], 'Model must execute the exact structured invocation once');
          const messages = session.messages.filter(message => !prior.has(JSON.stringify(message)));
          const search = messages.filter(m => m.role === 'toolResult' && m.toolName === 'tool_search');
          assert.equal(search.length, 1, 'Expected one targeted discovery');
          assert.deepEqual(search[0].details?.loaded, [operation.name]);
          const invocations = messages.filter(m => m.role === 'toolResult' && m.toolName === 'tool_invoke');
          assert.equal(invocations.length, 1, 'Expected one structured invocation');
          const retrievals = messages.filter(m => m.role === 'toolResult' && m.toolName === 'result_get');
          assert.equal(retrievals.length, 1, 'Model must retrieve the omitted evidence exactly once');
          assert.equal(retrievals[0].details?.selector, 'json.receipt.confirmation');
          assert.equal(retrievals[0].details?.atomicSourceRef, invocations[0].details?.resultRef);
          const results = messages.filter(m => m.role === 'toolResult');
          assert(!results.some(m => m.isError), 'Trial returned tool errors');
          const assistants = messages.filter(m => m.role === 'assistant');
          assert.equal(assistants.at(-1)?.stopReason, 'stop', 'Model stopped before completing its answer');
          assert(session.getLastAssistantText()?.includes(operation.proof), 'Final answer must contain the exact retrieved confirmation');
          const thoughts = assistants.flatMap(m => m.content).filter(c => c.type === 'thinking' && c.thinking?.trim());
          assert.equal(thoughts.length > 0, level !== 'off', 'Thinking toggle did not produce the expected separated reasoning');
          assert(!assistants.flatMap(m => m.content).some(c => c.type === 'text' && /<\/?think>|<tool_call>|call:tool_invoke/i.test(c.text)), 'Raw reasoning/tool tags leaked into visible text');
          const turnRequests = requests.slice(firstRequest);
          assert(turnRequests.length > 0 && turnRequests.length <= 8, 'Each turn must complete within eight provider requests');
          const tools = JSON.stringify(requests[0].tools), system = JSON.stringify(requests[0].messages.filter(m => m.role === 'system'));
          for (const request of turnRequests) {
            assert.equal(request.max_tokens, 4096); assert.equal(request.chat_template_kwargs, undefined);
            assert.equal(request.reasoning_effort, level === 'off' ? 'none' : model.thinkingLevelMap.medium || 'medium');
            for (const [key, value] of Object.entries(model.samplingParams)) assert.equal(request[key], value, `Sampling differs: ${key}`);
            assert.equal(request.top_k, undefined); assert.equal(request.min_p, undefined);
            assert.equal(JSON.stringify(request.tools), tools, 'Provider tool declarations changed');
            assert.equal(JSON.stringify(request.messages.filter(m => m.role === 'system')), system, 'Provider standing prompt changed');
                // Discovery grants survive schema-cache eviction, not transcript rewriting.
            // Old tool_search messages must remain byte-stable for prefix caching.
            for (const { id, content } of toolValues(request).filter(({ value }) => value.discovery === 'ready' && value.tools?.some(tool => tool.parameters))) {
              if (discoveryResults.has(id)) assert.equal(content, discoveryResults.get(id), 'Earlier discovery schema changed in provider history');
              discoveryResults.set(id, content);
            }
            for(const {id,content} of toolValues(request).filter(({value})=>value.selector==='json.receipt.confirmation' && Object.hasOwn(value,'value'))){
              if(retrievalResults.has(id))assert.equal(content,retrievalResults.get(id),'Retrieved evidence changed in provider history');
              retrievalResults.set(id,content);
            }
            for (const { id, content } of toolValues(request).filter(({ value }) => value.atomic_result)) {
              if (ordinaryResults.has(id)) assert.equal(content, ordinaryResults.get(id), 'Ordinary archived results changed in provider history');
              ordinaryResults.set(id, content);
            }
          }
          // Retrieved evidence remains durable across follow-up turns; old slices
          // are not credited as new executions and must retain their exact value.
          const wireSearch = turnRequests.flatMap(r => r.messages).find(m => m.role === 'tool' && m.tool_call_id === search[0].toolCallId && m.content?.includes('"parameters"'));
          assert(wireSearch, 'Discovery schema never reached the provider');
          assert.deepEqual(JSON.parse(wireSearch.content).tools[0].parameters, operation.parameters);
          assert.equal(JSON.parse(wireSearch.content).tools[0].name, operation.name);
          const archived = turnRequests.flatMap(toolValues).filter(({ id, value }) => id === invocations[0].toolCallId && value.atomic_result);
          assert(archived.length && archived.every(({ value }) => !JSON.stringify(value).includes(operation.proof)), 'Confirmation must be omitted from the compact tool result');
          assert(turnRequests.flatMap(toolValues).some(({ id, value }) => id === retrievals[0].toolCallId && value.value === operation.proof), 'Retrieved confirmation never reached the provider');
          assert.deepEqual(session.getActiveToolNames().sort(), [...ACTIVE_TOOLS].sort());
          roundReports.push({ turn: roundReports.length + 1, toolName: operation.name, status: 'passed', providerRequests: turnRequests.length, toolExecutions: 1, evidenceRetrievals: 1, separatedThinking: thoughts.length > 0,
            firstTokenMs: currentTurn.firstTokenMs === null ? null : Math.round(currentTurn.firstTokenMs), elapsedMs: Math.round(performance.now() - currentTurn.started),
            peakRequestBytes: Math.max(...turnRequests.map(request => Buffer.byteLength(JSON.stringify(request)))),
            reportedPromptTokens: Math.max(...assistants.map(message => (message.usage?.input || 0) + (message.usage?.cacheRead || 0) + (message.usage?.cacheWrite || 0))),
            reportedCachedTokens: assistants.reduce((sum, message) => sum + (message.usage?.cacheRead || 0), 0), generatedTokens: assistants.reduce((sum, message) => sum + (message.usage?.output || 0), 0) });
          log(`${level} turn ${roundReports.length}/${rounds} passed: ${turnRequests.length} requests, first event ${roundReports.at(-1).firstTokenMs} ms.`);
        }
        assert(compactions.every(event => event.status === 'passed'), 'Automatic compaction failed during the trial');
        progress.phase = 'loaded_context';
        const runtimeState = await inspectOllamaRuntime({ baseUrl: model.baseUrl, model: model.id, digest, fetchImpl });
        const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        cases.push({ thinkingLevel: level, status: 'passed', providerRequests: requests.length, toolExecutions: executed.length, evidenceRetrievals: roundReports.length, separatedThinking: level !== 'off', stableDeclarations: true, immutableToolResults: true,
          toolsSha256: hash(requests[0].tools), systemSha256: hash(requests[0].messages.filter(message => message.role === 'system')),
          ...schemaBudget(requests), runtime: runtimeState,
          firstTokenMs: roundReports[0].firstTokenMs, elapsedMs: Math.round(performance.now() - started), generatedTokens: roundReports.reduce((sum, round) => sum + round.generatedTokens, 0), compactions, rounds: roundReports });
      } finally {
        clearTimeout(timer); await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose();
      }
    }
    return report('passed');
  } catch (error) {
    error.trialReport = { ...report('failed'), failure: { error: error.message, thinkingLevel: progress?.thinkingLevel, phase: progress?.phase,
      turn: progress?.turn, completedTurns: progress?.roundReports.length || 0, providerRequests: progress?.requests.length || 0,
      elapsedMs: progress ? Math.round(performance.now() - progress.started) : null, timedOut: progress?.timedOut || false,
      lastStopReason: progress?.lastStopReason, providerError: progress?.providerError, rounds: progress?.roundReports || [], compactions: progress?.compactions || [] } };
    throw error;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const definition = qwenDefinition(process.argv[2] || '4b');
  const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
  const trialDir = path.join(agentDir, 'model-trials/qwen-32k', definition.key);
  const reportPath = path.join(trialDir, 'probe.json');
  let baseUrl;
  try {
    // Invalidate a previous pass before doing new inference checks.
    await writeJson(reportPath, { status: 'running', model: definition.model, checkedAt: new Date().toISOString() });
    const sdk = await loadSdk();
    const runtime = await sdk.ModelRuntime.create({ modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
    const model = runtime.getModel('ollama', definition.model); assert(model, 'Qwen alias missing from the synchronized Pi catalog');
    const atomicPath = process.env.PI_ATOMIC_EXTENSION_PATH || '/opt/pi-extensions/pi-atomic-tool-results';
    const { default: atomicFactory } = await import(pathToFileURL(path.join(atomicPath, 'index.js')));
    baseUrl = model.baseUrl.replace(/\/v1\/?$/, '');
    const inspect = async id => {
      const response = await fetch(`${baseUrl}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(30000) });
      assert(response.ok, 'Ollama alias inspection failed'); return response.json();
    };
    const show = await inspect(model.id), source = await inspect(definition.source);
    verifyQwenAlias(source, show);
    const prepared = await readJson(path.join(trialDir, 'prepared.json'));
    const tagsResponse = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(30000) }); assert(tagsResponse.ok);
    const digest = (await tagsResponse.json()).models?.find(m => m.name === model.id)?.digest;
    assert(digest && digest === prepared.digest && prepared.model === model.id, 'Prepared alias changed; prepare it again before probing');
    const report = await probeQwen({ sdk, model, atomicFactory, show, digest, rounds: integer(process.env.PI_QWEN_PROBE_ROUNDS, 2, 2, 12, 'Qwen probe rounds'), timeoutMs: integer(process.env.PI_QWEN_PROBE_TIMEOUT_MS, 600000, 10000, 3600000, 'Qwen probe timeout') });
    Object.assign(report, { key: definition.key, source: definition.source, digest, ollamaVersion: prepared.ollamaVersion });
    await writeJson(reportPath, report); console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeJson(reportPath, { ...(error.trialReport || { version: 2, status: 'failed', model: definition.model, error: error.message, checkedAt: new Date().toISOString() }), key: definition.key, source: definition.source });
    console.error(`[qwen] Probe failed: ${error.message}`); process.exitCode = 1;
  } finally {
    // Release only this trial alias between candidates, keeping the host's other
    // loaded models and Ollama service settings intact.
    if (baseUrl) try {
      const unloaded = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: definition.model, keep_alive: 0, stream: false }), signal: AbortSignal.timeout(30000) });
      if (!unloaded.ok) console.error('[qwen] Trial model unload failed; Ollama will use its normal eviction policy.');
    } catch { console.error('[qwen] Trial model unload unavailable; Ollama will use its normal eviction policy.'); }
  }
}
