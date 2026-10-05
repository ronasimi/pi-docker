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
if (process.argv.includes('--sdk-only')) {
  console.log('Verified Pi ESM SDK imports and pinned versions.');
  process.exit(0);
}
const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
const webDir = process.env.PI_WEB_DATA_DIR || '/home/pi/.pi-web';
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
console.log('Verified Pi 1.0.0, Web UI 0.97.0, SDK exports, startup tools and six deferred MCP domains.');
