#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const webRoot = '/usr/local/lib/node_modules/pi-web-ui';
// Pi exposes an import-only entry; CommonJS require.resolve rejects it.
const sdkEntry = path.join(webRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const sdkRoot = path.dirname(path.dirname(sdkEntry));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
assert.equal(read('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json').version, '1.0.0');
assert.equal(read(path.join(sdkRoot, 'package.json')).version, '1.0.0');
assert.equal(read(path.join(webRoot, 'package.json')).version, '0.97.0');
const sdk = await import(pathToFileURL(sdkEntry));
for (const name of ['createMcpExtension', 'createToolSearchExtension']) assert.equal(typeof sdk[name], 'function');
function jsFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(file));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) out.push(file);
  }
  return out;
}
for (const root of ['/usr/local/lib/node_modules/@earendil-works/pi-coding-agent', sdkRoot]) {
  const compiled = jsFiles(path.join(root, 'dist')).map(file => fs.readFileSync(file, 'utf8'));
  assert(compiled.some(text => text.includes('Maximum number of tools to return. Defaults to 1.')), `Missing patched tool_search schema under ${root}`);
  assert(!compiled.some(text => text.includes('Maximum number of tools to return. Defaults to 8.')), `Old tool_search default remains under ${root}`);
}
if (process.argv.includes('--sdk-only')) {
  console.log('Verified Pi ESM SDK imports, pinned versions, and tool_search default-limit patch.');
  process.exit(0);
}
const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
const webDir = process.env.PI_WEB_DATA_DIR || '/home/pi/.pi-web';
const guardPath = path.join(agentDir, 'extensions/tool-search-default-limit.js');
assert(fs.existsSync(guardPath), 'Missing runtime tool_search default-limit guard');
const guardModule = await import(pathToFileURL(guardPath));
let toolCallGuard;
guardModule.default({on(event, handler) { if (event === 'tool_call') toolCallGuard = handler; }});
assert.equal(typeof toolCallGuard, 'function', 'Runtime tool_search guard did not register tool_call hook');
const omitted = {toolName: 'tool_search', input: {query: 'get_host_interface_info'}};
toolCallGuard(omitted);
assert.equal(omitted.input.limit, 1, 'Runtime guard must set omitted tool_search.limit to 1');
const explicit = {toolName: 'tool_search', input: {query: 'network assessment', limit: 3}};
toolCallGuard(explicit);
assert.equal(explicit.input.limit, 3, 'Runtime guard must preserve explicit tool_search.limit');
const promptText = fs.readFileSync(path.join(agentDir, 'APPEND_SYSTEM.md'), 'utf8');
assert(promptText.includes('# Skill and deferred-tool discipline'), 'Missing skill/tool discovery routing guard in APPEND_SYSTEM.md');
const settings = read(path.join(agentDir, 'settings.json'));
assert.deepEqual(settings.defaultTools, ['read', 'bash', 'edit', 'write', 'tool_search']);
const web = read(path.join(webDir, 'client-state.json')).__settings__.settings;
const { AGENT_TOOL_CATALOG } = await import(pathToFileURL(path.join(webRoot, 'dist/server/tool-manager.js')));
for (const {name} of AGENT_TOOL_CATALOG) assert(web.disabledAgentTools.includes(name), `Optional Web UI tool enabled: ${name}`);
assert.equal(web.defaultAgentPreset, 'standard');
const mcp = read(path.join(agentDir, 'mcp.json'));
for (const name of ['system', 'security', 'google', 'memory', 'playwright', 'searxng']) {
  assert.equal(mcp.mcpServers[name].exposure, 'deferred', `${name} must use native discovery`);
  assert(mcp.mcpServers[name].description, `${name} requires a server summary`);
}
console.log('Verified Pi 1.0.0, Web UI 0.97.0, SDK exports, runtime tool_search guard, skill routing prompt, startup tools and six deferred MCP domains.');
