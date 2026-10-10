import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_TOOLS, MCP_SERVERS, connectedCatalogs, verifySession } from '../scripts/verify-runtime-session.mjs';

function offlineSdk(tools) {
  let disposed = false;
  return {
    get disposed() { return disposed; },
    ModelRuntime: { create: async () => ({ registerProvider() {}, getModel: () => ({ id: 'verification' }) }) },
    createMcpExtension: () => () => {},
    createToolSearchExtension: () => () => {},
    createAgentSessionServices: async () => ({
      diagnostics: [], resourceLoader: { getExtensions: () => ({ errors: [] }) },
    }),
    createAgentSessionFromServices: async () => ({ session: {
      getAllTools: () => tools,
      getActiveToolNames: () => [...ACTIVE_TOOLS],
      bindExtensions: async () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => { disposed = true; },
      prompt: () => { throw Error('Normal startup verification must not send a provider prompt'); },
    } }),
    SessionManager: { inMemory: () => ({}) },
  };
}
const web = { AGENT_TOOL_CATALOG: [], applyAgentToolsGating() {} };

test('catalog reporting distinguishes absent services and does not confuse prefix matches', () => {
  const tools = [{ name: 'mcp__system__host_info' }, { name: 'mcp__security__scan' }, { name: 'mcp__google_other__bad' }, { name: 'tool_search' }];
  assert.deepEqual(connectedCatalogs(tools), {
    connected: ['system', 'security'], missing: ['google', 'memory', 'playwright', 'searxng'],
  });
  assert.deepEqual(MCP_SERVERS, ['system', 'security', 'google', 'memory', 'playwright', 'searxng']);
});

test('normal startup validation succeeds when google MCP is unavailable', async () => {
  const sdk = offlineSdk([{ name: 'mcp__system__inspect_state', exposure: 'deferred' }]);
  const result = await verifySession({ sdk, web, agentDir: '/ignored', cwd: '/ignored', requireMcp: false });
  assert.equal(result.requests, 0);
  assert.equal(result.discoveryChecked, false);
  assert.deepEqual(result.connected, ['system']);
  assert.deepEqual(result.missing, ['security', 'google', 'memory', 'playwright', 'searxng']);
  assert.equal(result.deferred, 1);
  assert.equal(result.active.length, 8);
  assert(sdk.disposed);
});

test('normal startup validation succeeds with no MCP servers available', async () => {
  const sdk = offlineSdk([]);
  const result = await verifySession({ sdk, web, agentDir: '/ignored', cwd: '/ignored', requireMcp: false });
  assert.deepEqual(result.connected, []);
  assert.deepEqual(result.missing, MCP_SERVERS);
  assert(sdk.disposed);
});

test('strict validation still fails without the Google catalog', async () => {
  const tools = MCP_SERVERS.filter(name => name !== 'google').map(name => ({ name: `mcp__${name}__status`, exposure: 'deferred' }));
  const sdk = offlineSdk(tools);
  await assert.rejects(verifySession({ sdk, web, agentDir: '/ignored', cwd: '/ignored', timeoutMs: 0, requireMcp: true }), /No connected catalog for google/);
  assert(sdk.disposed);
});

test('normal image validation is optional and strict MCP validation is opt-in', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const verifier = await fs.readFile(path.join(root, 'scripts/verify-stock-runtime.mjs'), 'utf8');
  const health = await fs.readFile(path.join(root, 'scripts/validate-image.sh'), 'utf8');
  const setup = await fs.readFile(path.join(root, 'scripts/setup-qwen.sh'), 'utf8');
  assert.match(verifier, /process\.argv\.includes\('--strict-mcp'\)/);
  assert.match(verifier, /requireMcp: strictMcp/);
  assert.match(verifier, /MCP unavailable or not connected:/);
  assert.doesNotMatch(health, /--strict-mcp/);
  assert.match(setup, /bash scripts\/validate-image.sh/);
  assert.match(setup, /prepare-qwen-trial\.mjs/);
});
