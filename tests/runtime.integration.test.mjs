import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = process.env.PI_TEST_SCRIPTS_DIR || path.join(root, 'scripts');
const sdkRoot = process.env.PI_SDK_ROOT || '/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent';
const webRoot = process.env.PI_WEB_UI_ROOT || '/opt/pi-runtime/node_modules/pi-web-ui';
const configRoot = process.env.PI_DEFAULT_CONFIG_DIR || path.join(root, 'config');
const atomicPath = process.env.PI_ATOMIC_EXTENSION_PATH || path.join(root, 'extensions/pi-atomic-tool-results');
const { applyRuntimePolicy } = await import(pathToFileURL(path.join(scripts, 'apply-runtime-policy.mjs')));
const { verifySession } = await import(pathToFileURL(path.join(scripts, 'verify-runtime-session.mjs')));
const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')));
const web = await import(pathToFileURL(path.join(webRoot, 'dist/server/tool-manager.js')));

test('real Pi/Web UI: all catalog models default to <=32K, aliases and tool switches persist across replay', { timeout: 30000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-image-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const agentDir = path.join(temp, 'agent'), webDir = path.join(temp, 'web'), etc = path.join(temp, 'etc');
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir; });
  for (const p of [agentDir, webDir, etc]) await fs.mkdir(p);
  const legacyDir = path.join(agentDir, 'extensions/pi-atomic-tool-results');
  await fs.mkdir(legacyDir, { recursive: true });
  // A retained 0.1.4 copy has an older result hook that replaces discovery
  // metadata. A duplicate 0.1.5 fixture concealed this upgrade failure.
  const legacySource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy-atomic-0.1.4.mjs');
  const legacyCode = await fs.readFile(legacySource, 'utf8');
  await fs.writeFile(path.join(legacyDir, 'index.js'), legacyCode);
  await fs.writeFile(path.join(legacyDir, 'package.json'), JSON.stringify({ name: 'pi-atomic-tool-results', version: '0.1.4', type: 'module', pi: { extensions: ['./index.js'] } }));
  for (const [source, target] of [['settings.json', 'default-settings.json'], ['web-settings.json', 'default-web-settings.json']]) await fs.copyFile(path.join(configRoot, source), path.join(etc, target));
  await fs.copyFile(path.join(configRoot, 'APPEND_SYSTEM.md'), path.join(agentDir, 'APPEND_SYSTEM.md'));
  const id = 'gemma4:e4b-it-qat-32k';
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { ollama: { api: 'openai-completions', apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1', models: [{ id, input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096 }] }, private: { api: 'openai-completions', apiKey: '${UNCHANGED_SECRET}', baseUrl: 'http://localhost:1/v1', models: [{ id: 'custom', contextWindow: 100000, maxTokens: 50000 }] } } }));
  await fs.writeFile(path.join(agentDir, 'model-aliases-32k.json'), JSON.stringify({ aliases: { 'gemma4:e4b-it-qat-64k': id } }));
  const builtin = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const cached = { ...builtin.getModels('google')[0], id: 'fixture-new-cached', contextWindow: 1000000, maxTokens: 65536 };
  await fs.writeFile(path.join(agentDir, 'models-store.json'), JSON.stringify({ google: { models: [cached], lastModified: Date.now() + 86400000, checkedAt: Date.now() } }));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'gemma4:e4b-it-qat-64k', modelThinkingLevels: { 'ollama/gemma4:e4b-it-qat-64k': 'low' }, compaction: { enabled: false, modelOverrides: { 'ollama/gemma4:e4b-it-qat-64k': { reserveTokens: 0 } } } }));
  await fs.writeFile(path.join(webDir, 'client-state.json'), JSON.stringify({ __settings__: { defaultModel: 'ollama/gemma4:e4b-it-qat-64k', settings: { disabledAgentTools: [], disabledExtensions: ['builtin:mcp', 'unrelated'], customSystemPrompt: 'Keep my project instructions', toolApprovalEnabled: true } } }));
  const env = { ...process.env, PI_SDK_ROOT: sdkRoot, PI_WEB_UI_ROOT: webRoot, PI_CODING_AGENT_DIR: agentDir, PI_WEB_DATA_DIR: webDir, PI_DEFAULT_CONFIG_DIR: etc, PI_ATOMIC_EXTENSION_PATH: atomicPath, PI_NATIVE_SERVICES_PATH:path.resolve(atomicPath,"../pi-native-services") };
  // Docker exposes /opt/pi-app/scripts through /usr/local/lib/pi-docker.
  // Exercise the actual CLI through a directory symlink before importing its API.
  const scriptLink = path.join(temp, 'legacy-script-path');
  // Node's permission harness denies fs.symlink even for allowed temp paths.
  execFileSync('ln', ['-s', scripts, scriptLink]);
  execFileSync(process.execPath, [path.join(scriptLink, 'apply-runtime-policy.mjs')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cliState = JSON.parse(await fs.readFile(path.join(webDir, 'client-state.json'), 'utf8'));
  assert(cliState.__settings__.settings.disabledAgentTools.includes('schedule'), 'Symlinked startup CLI must apply the current optional-tool catalog');
  const result = await applyRuntimePolicy({ env });
  assert(result.modelCount > 100, 'Compose the actual bundled provider catalog');
  assert.equal(result.models.providers.private.apiKey, '${UNCHANGED_SECRET}');
  assert.equal(result.models.providers.google.modelOverrides['fixture-new-cached'].contextWindow, 32768, 'Newer cached catalog models must also get the context default');
  assert.equal(result.settings.defaultModel, id);
  assert.equal(result.settings.compaction.enabled, true);
  assert.equal(result.settings.modelThinkingLevels[`ollama/${id}`], 'low');
  assert.equal(result.state.__settings__.settings.customSystemPrompt, 'Keep my project instructions');
  assert.deepEqual(result.state.__settings__.settings.disabledExtensions, ['unrelated']);
  const runtime = await sdk.ModelRuntime.create({ modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
  assert(!runtime.getError());
  for (const model of runtime.getModels()) assert(model.contextWindow <= 32768 && model.maxTokens < model.contextWindow, `${model.provider}/${model.id}: context=${model.contextWindow}, output=${model.maxTokens}`);
  const { ClientStateStore } = await import(pathToFileURL(path.join(webRoot, 'dist/server/client-state.js')));
  const client = new ClientStateStore(path.join(webDir, 'client-state.json')).getSettings('fresh-browser');
  assert.equal(client.disabledAgentTools.length, web.AGENT_TOOL_CATALOG.length + 4);
  assert.equal(client.softCapTokens, 24576); assert.equal(client.defaultAgentPreset, 'standard');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/mcp-fixture.mjs');
  const mcp = { autoEnableCodemode: false, mcpServers: Object.fromEntries(['system', 'security', 'google', 'memory', 'playwright', 'searxng'].map(name => [name, { command: process.execPath, args: [fixture, name, name === 'memory' ? '12' : '1'], exposure: 'deferred', description: `${name} project tools` }])) };
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify(mcp));
  const checked = await verifySession({ sdk, agentDir, cwd: temp, web, timeoutMs: 10000 });
  assert.equal(checked.active.length, 8); assert(checked.deferred >= 6);
  assert.equal(await fs.readFile(path.join(legacyDir, 'index.js'), 'utf8'), legacyCode, 'Disable retained copies without deleting user files');
  // Reapplying policy must preserve the same serialized catalogs/settings.
  const before = await fs.readFile(path.join(agentDir, 'models.json'), 'utf8');
  await applyRuntimePolicy({ env });
  assert.equal(await fs.readFile(path.join(agentDir, 'models.json'), 'utf8'), before);
  // Create the actual Web UI client/session factory, not only its tool-manager helper.
  let ClientSession;
  try { ({ ClientSession } = await import(pathToFileURL(path.join(webRoot, 'dist/server/agent-service.js')))); }
  catch (error) {
    if (process.env.PI_REQUIRE_WEB_UI === '1' || !error.message.includes('pty.node')) throw error;
    await t.test('actual Web UI client startup and settings replay', { skip: 'Cached offline dependency tree has no native pty.node; mandatory during Docker build' }, () => {});
    console.log(`Validated ${result.modelCount} real catalog models, ${web.AGENT_TOOL_CATALOG.length} disabled optional tools, six MCP connections and two stable-prefix provider requests.`);
    return;
  }
  const priorOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  let cs;
  try {
    cs = await ClientSession.create('image-validation', temp, new ClientStateStore(path.join(webDir, 'client-state.json')), { blank: true });
    assert.deepEqual(cs.session.resourceLoader.getExtensions().errors, [], 'Actual Web UI must have no retained extension conflicts');
    const deadline = Date.now() + 10000;
    while (cs.session.getAllTools().filter(t => t.name.startsWith('mcp__')).length < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(cs.session.getActiveToolNames().sort(), [...checked.active].sort(), 'Actual Web UI session must expose only the configured tools');
    assert.equal(cs.session.model.contextWindow, 32768);
    assert.equal(cs.session.settingsManager.getCompactionSettings(cs.session.model).reserveTokens, 8192);
    await cs.settingsSvc.set({ disabledAgentTools: [...client.disabledAgentTools] });
    // Exercise the actual provider boundary after stock Web UI settings replay.
    const requests=[];
    const provider=http.createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const n=requests.length,search=n%2===1;
      const delta=search?{role:'assistant',tool_calls:[{index:0,id:`web-${n}`,type:'function',function:{name:'tool_search',arguments:JSON.stringify({query:'memory search'})}}]}:{role:'assistant',content:'Checked catalog.'};
      res.writeHead(200,{'content-type':'text/event-stream'});
      const base={id:`web-${n}`,object:'chat.completion.chunk',created:1,model:'web-check'};
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:search?'tool_calls':'stop'}]})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise(r=>provider.listen(0,'127.0.0.1',r));
    try {
      cs.session.modelRuntime.registerProvider('web-check',{api:'openai-completions',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'fixture',models:[{id:'web-check',name:'Web fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false}}]});
      await cs.session.setModel(cs.session.modelRuntime.getModel('web-check','web-check'));
      await cs.session.prompt('Verify the memory catalog, then finish without invoking targets.');
      await cs.settingsSvc.set({disabledAgentTools:[...client.disabledAgentTools]});
      await cs.session.prompt('Verify the memory catalog again, then finish without invoking targets.');
      assert.equal(requests.length,4);
      for(const request of requests)assert.deepEqual(request.tools.map(t=>t.function.name).sort(),[...checked.active].sort(),'Stock Web UI replay leaked provider declarations');
      assert.equal(JSON.stringify(requests[0].tools),JSON.stringify(requests[3].tools));
      assert.equal(JSON.stringify(requests[0].messages.filter(m=>m.role==='system')),JSON.stringify(requests[3].messages.filter(m=>m.role==='system')),'Web UI changed the standing prefix after replay');
      assert.deepEqual(cs.session.getActiveToolNames().sort(),[...checked.active].sort());
    } finally {provider.closeAllConnections();await new Promise(r=>provider.close(r));}
  } finally {
    await cs?.dispose();
    if (priorOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = priorOffline;
  }
  console.log(`Validated ${result.modelCount} real catalog models, ${web.AGENT_TOOL_CATALOG.length} disabled optional tools, six MCP connections and two stable-prefix provider requests.`);
});

test('live validator reports retained extension conflicts before sending provider requests', { timeout: 10000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-conflict-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const legacyDir = path.join(temp, 'extensions/pi-atomic-tool-results');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy-atomic-0.1.4.mjs'), path.join(legacyDir, 'index.js'));
  await fs.writeFile(path.join(legacyDir, 'package.json'), JSON.stringify({ name: 'pi-atomic-tool-results', version: '0.1.4', type: 'module', pi: { extensions: ['./index.js'] } }));
  await fs.writeFile(path.join(temp, 'settings.json'), JSON.stringify({
    defaultTools: ['read', 'bash', 'edit', 'write', 'tool_search'],
    extensions: ['-builtin:mcp', '-builtin:tool-search', '-builtin:codemode', '-builtin:llama.cpp', path.resolve(atomicPath,'../pi-native-services'), atomicPath],
  }));
  await assert.rejects(verifySession({ sdk, agentDir: temp, cwd: temp, web, requireMcp: false }), error => {
    assert.match(error.message, /Extension load\/conflict diagnostics/);
    assert.match(error.message, /result_get.*conflicts/s);
    return true;
  });
});
