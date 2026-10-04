#!/usr/bin/env node
// Offline SDK integration test: catalog discovery only, no model requests/scans.
// node tests/native-mcp-smoke.mjs SDK_ROOT WEB_UI_ROOT MCP_GATEWAY_ROOT
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [sdkRoot, webRoot, gatewayRoot] = process.argv.slice(2).map(p => path.resolve(p));
assert(sdkRoot && webRoot && gatewayRoot, 'Supply SDK, Web UI and gateway roots');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-pi-mcp-'));
process.env.PI_CODING_AGENT_DIR = temp;
const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')));
const {AGENT_TOOL_CATALOG, applyAgentToolsGating} = await import(pathToFileURL(path.join(webRoot, 'dist/server/tool-manager.js')));
const domains = {system: 'system-tools.mjs', security: 'security-tools.mjs', google: 'google-tools.mjs'};
await fs.writeFile(path.join(temp, 'mcp.json'), JSON.stringify({mcpServers: Object.fromEntries(
  Object.entries(domains).map(([name, file]) => [name, {
    command: process.execPath, args: [path.join(gatewayRoot, 'scripts', file)],
    env: {MCP_WORKSPACE: temp}, exposure: 'deferred',
  }])
)}));
await fs.writeFile(path.join(temp, 'settings.json'), JSON.stringify({defaultTools: ['read','bash','edit','write','tool_search']}));
let session;
try {
  const services = await sdk.createAgentSessionServices({cwd: temp, agentDir: temp, resourceLoaderOptions: {
    extensionFactories: [
      {name: 'mcp', builtin: true, replaceable: true, factory: sdk.createMcpExtension()},
      {name: 'tool-search', builtin: true, replaceable: true, factory: sdk.createToolSearchExtension()},
    ],
  }});
  assert.deepEqual(services.diagnostics, []);
  ({session} = await sdk.createAgentSessionFromServices({services, sessionManager: sdk.SessionManager.inMemory(temp)}));
  await session.bindExtensions({});
  const deadline = Date.now() + 15000;
  while (session.getAllTools().filter(t => t.name.startsWith('mcp__')).length < 142 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(session.getAllTools().filter(t => t.name.startsWith('mcp__')).length, 142, 'Every owned catalog must connect');
  const disabled = [...AGENT_TOOL_CATALOG.map(t => t.name), 'powershell','ls','grep','find'];
  applyAgentToolsGating(session, disabled, 'standard');
  assert.deepEqual(session.getActiveToolNames().sort(), ['read','bash','edit','write','tool_search'].sort());
  const search = session.getToolDefinition('tool_search');
  for (const [query, expected] of [
    ['local daily briefing', 'mcp__system__local_daily_briefing'],
    ['passive wireless assessment', 'mcp__security__analyze_wireless_environment'],
    ['how many unread emails', 'mcp__google__gmail_get_unread_count'],
  ]) {
    const result = await search.execute('smoke', {query, limit: 1});
    assert.deepEqual(result.details.loaded, [expected], query);
    applyAgentToolsGating(session, disabled, 'standard');
    assert(session.getActiveToolNames().includes(expected));
    console.log(`${query} -> ${expected}`);
  }
  assert.equal(session.getActiveToolNames().filter(t => t.startsWith('mcp__')).length, 3, 'Settings reload must keep the remaining catalog deferred');
  console.log('Native SDK smoke passed: 142 deferred tools, five startup tools, three exact discoveries and Web UI replay.');
} finally {
  if (session) await session.extensionRunner.emit({type: 'session_shutdown', reason: 'exit'});
  session?.dispose();
  await fs.rm(temp, {recursive: true, force: true});
}
