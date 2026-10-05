#!/usr/bin/env node
// Build-time SDK configuration for pi-web-ui 0.97.0. Pi itself is unmodified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '/usr/local/lib/node_modules/pi-web-ui');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '0.97.0');
const definitions = [
  {
    file: 'dist/server/agent-service.js',
    sha: 'cda3c11b9db7fdb9e4e4861d7ad53bdaf618366ba24460b981e0562184856f57',
    edits: [
      ['import { createAgentSessionFromServices,', 'import { createMcpExtension, createToolSearchExtension, createAgentSessionFromServices,'],
      ['                    extensionFactories: [\n', '                    extensionFactories: [\n                        { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },\n                        { name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },\n'],
    ],
  },
  {
    file: 'dist/server/tool-manager.js',
    sha: 'd3c842511ee3ca24be638cdfc8c0f4071ebd42bf691926f0c8b4fd77e881124c',
    edits: [['        const names = new Set(allNames);', '        const names = new Set(session.getActiveToolNames());']],
  },
];

// Check every source first; an upstream change aborts the build before any edit.
const updates = definitions.map(({file, sha, edits}) => {
  const filename = path.join(root, file);
  let source = fs.readFileSync(filename, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), sha, `Unexpected upstream source: ${file}`);
  for (const [before, after] of edits) {
    assert.equal(source.split(before).length, 2, `Expected one SDK configuration location in ${file}`);
    source = source.replace(before, after);
  }
  return [filename, source];
});
for (const [filename, source] of updates) fs.writeFileSync(filename, source);

const { AGENT_TOOL_CATALOG, applyAgentToolsGating } = await import(pathToFileURL(path.join(root, 'dist/server/tool-manager.js')));
const disabled = [...AGENT_TOOL_CATALOG.map(t => t.name), 'powershell', 'ls', 'grep', 'find'];
// Exercise the actual Web UI function after a discovery/load cycle and settings replay.
let active = ['read', 'bash', 'edit', 'write', 'tool_search', 'mcp__system__docker_list_containers'];
const deferred = 'mcp__system__local_daily_briefing';
const mock = {
  getActiveToolNames: () => [...active],
  getAllTools: () => [...new Set([...active, deferred, ...disabled])].map(name => ({name})),
  setActiveToolsByName: names => { active = names; },
};
applyAgentToolsGating(mock, disabled, 'standard');
assert(!active.includes(deferred), 'Settings replay exposed an undiscovered MCP schema');
assert(active.includes('mcp__system__docker_list_containers'), 'Settings replay lost a discovered tool');
assert(active.includes('tool_search'), 'Native discovery was disabled');
console.log('Web UI uses upstream MCP/tool-search factories and preserves deferred tool activation.');
