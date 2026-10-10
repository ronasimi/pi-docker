#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readJson, loadSdk } from './config-common.mjs';
import { CONTEXT_CAP, configuredContext } from './model-policy.mjs';
import { verifySession, MCP_SERVERS } from './verify-runtime-session.mjs';

import { VERSIONS, RUNTIME_ROOT, sdkOrigin } from './runtime-versions.mjs';
import { verifyUpstreamIntegrity } from './upstream-integrity.mjs';
const webRoot = process.env.PI_WEB_UI_ROOT || path.join(RUNTIME_ROOT,'node_modules/pi-web-ui');
const sdkRoot = process.env.PI_SDK_ROOT || path.join(RUNTIME_ROOT,'node_modules/@earendil-works/pi-coding-agent');
const webSdkRoot = sdkOrigin(webRoot);
assert.equal(await fs.realpath(webSdkRoot), await fs.realpath(sdkRoot), 'CLI and Web UI must resolve one SDK installation');
assert.equal((await readJson(path.join(sdkRoot, 'package.json'))).version, VERSIONS.pi);
assert.equal((await readJson(path.join(webRoot, 'package.json'))).version, VERSIONS.web);
const sdk = await loadSdk(sdkRoot), webSdk = sdk;
for (const api of ['createMcpExtension', 'createToolSearchExtension', 'ModelRuntime', 'createAgentSessionServices']) assert.equal(typeof sdk[api], 'function');
const checkedFiles = await verifyUpstreamIntegrity(RUNTIME_ROOT);
const atomic = process.env.PI_ATOMIC_EXTENSION_PATH || '/opt/pi-extensions/pi-atomic-tool-results';
assert.equal((await readJson(path.join(atomic, 'package.json'))).version, VERSIONS.atomic);
const {RUNTIME_FINGERPRINT}=await import(pathToFileURL(path.join(atomic,'lib/runtime.js')));
assert.equal(RUNTIME_FINGERPRINT.atomicVersion,VERSIONS.atomic);
console.log(`Harness ${RUNTIME_FINGERPRINT.release}, atomic ${RUNTIME_FINGERPRINT.atomicVersion}, source ${RUNTIME_FINGERPRINT.extensionSha256}`);
const bridge = process.env.PI_NATIVE_SERVICES_PATH || '/opt/pi-extensions/pi-native-services';
assert.equal((await readJson(path.join(bridge,'package.json'))).version, VERSIONS.bridge);
if (process.argv.includes('--sdk-only')) {
  console.log(`Verified clean Pi ${VERSIONS.pi}, Web UI ${VERSIONS.web}, one SDK, ${checkedFiles} unmodified upstream files and extension ${VERSIONS.atomic}.`);
  process.exit(0);
}
assert(!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY, 'Google/Gemini Docker environment keys must remain disabled');
for (const binary of ['bash', 'curl', 'git', 'jq', 'python3', 'rg', 'ssh']) {
  const found = await Promise.all(process.env.PATH.split(path.delimiter).map(dir => fs.access(path.join(dir, binary), fs.constants.X_OK).then(() => true, () => false)));
  assert(found.some(Boolean), `Missing image utility: ${binary}`);
}
const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
const webDir = process.env.PI_WEB_DATA_DIR || '/home/pi/.pi-web';
const settings = await readJson(path.join(agentDir, 'settings.json'));
assert.deepEqual(settings.defaultTools, ['read', 'bash', 'edit', 'write', 'tool_search']);
assert(settings.extensions.includes(atomic));
assert.equal(settings.compaction.enabled, true); assert.equal(settings.compaction.reserveTokens, 8192); assert.equal(settings.compaction.keepRecentTokens, 4096);
const web = await import(pathToFileURL(path.join(webRoot, 'dist/server/tool-manager.js')));
const client = (await readJson(path.join(webDir, 'client-state.json'))).__settings__.settings;
for (const { name } of web.AGENT_TOOL_CATALOG) assert(client.disabledAgentTools.includes(name), `Optional Web UI tool enabled: ${name}`);
assert.equal(client.defaultAgentPreset, 'standard'); assert.equal(client.softCapTokens, 24576);
const mcp = await readJson(path.join(agentDir, 'mcp.json'));
assert.equal(mcp.autoEnableCodemode, false);
for (const name of MCP_SERVERS) {
  assert.equal(mcp.mcpServers[name].exposure, 'deferred'); assert.notEqual(mcp.mcpServers[name].enabled, false);
  assert(mcp.mcpServers[name].description, `${name} needs a stable description`);
  for (const exposure of Object.values(mcp.mcpServers[name].toolExposure || {})) assert(['deferred', 'hidden'].includes(exposure));
}
const prompt = await fs.readFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'utf8');
assert(Buffer.byteLength(prompt) <= 4096, 'Standing addendum grew beyond 4 KiB');
assert(prompt.includes('tool_invoke') && prompt.includes('result_get'));
const runtime = await sdk.ModelRuntime.create({ modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
assert(!runtime.getError(), 'Invalid models.json');
const models = runtime.getModels();
for (const model of models) assert(model.contextWindow <= CONTEXT_CAP && model.maxTokens < model.contextWindow, `Invalid context budget: ${model.provider}/${model.id}`);
const aliases = (await readJson(path.join(agentDir, 'model-aliases-32k.json'))).aliases || {};
const visible = models.filter(m => m.provider === 'ollama');
for (const model of visible) {
  if (aliases[model.id]) assert.equal(model.id, aliases[model.id], `Superseded alias visible: ${model.id}`);
}
console.log(`Validated ${models.length} chat model budgets, 24K compaction, eight startup tools and six deferred MCP configurations.`);
if (process.argv.includes('--config-only')) process.exit(0);
const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434').replace(/\/$/, '');
for (const model of visible) {
  const response = await fetch(`${baseUrl}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id }), signal: AbortSignal.timeout(10000) });
  assert(response.ok, `Ollama inspection failed: ${model.id}`);
  const show = await response.json();
  if (model.contextWindow === CONTEXT_CAP && !show.remote_host && !show.remote_model) assert.equal(configuredContext(show), CONTEXT_CAP, `Actual Ollama allocation differs: ${model.id}`);
}
// Strict live connectivity is an explicit diagnostic, not a dependency of Qwen
// model installation. Image-build tests already prove discovery with fixtures.
const strictMcp = process.argv.includes('--strict-mcp');
const result = await verifySession({ sdk: webSdk, agentDir, cwd: process.env.PI_WEB_CWD || '/workspace', web,
  requireMcp: strictMcp });
console.log(`SDK runtime passed: ${result.active.length} active tools; ${result.deferred} currently deferred tools; ${result.connected.length}/${MCP_SERVERS.length} live MCP catalogs.`);
if (result.missing.length) console.warn(`[pi] MCP unavailable or not connected: ${result.missing.join(', ')}. The normal runtime validation does not require optional external services.`);
if (strictMcp) console.log('Strict MCP validation passed: all six live catalogs, native tool_search, schema lease and provider transport.');
else console.log('Native discovery/provider serialization is tested by the image-build MCP fixtures; use --strict-mcp to check live endpoints.');
