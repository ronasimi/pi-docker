import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ALLOWED_TOOLS } from '../gate.mjs';

test('real Pi SDK + adapter: discovery, validation, repeat calls, retries, reload and branch isolation', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gate-integration-'));
  const oldConfig = process.env.PI_MCP_CONFIG;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const requests = [];
  const toolCalls = [];
  let step = 0;
  let failNext = false;
  const scripted = [
    ['mcp_call', { tool: 'playwright_browser_navigate', args: { url: 'https://example.com' } }],
    ['mcp_search', { query: 'browser_navigate', server: 'playwright' }],
    ['mcp_call', { tool: 'playwright_browser_navigate', args: {} }],
    ['mcp_call', { tool: 'playwright_browser_navigate', args: {} }],
    ['mcp_call', { tool: 'playwright_browser_navigate', args: { url: 'https://example.com' } }],
  ];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (req.url === '/v1/chat/completions') {
      requests.push(input);
      const current = scripted.shift();
      step++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const base = { id: 'mock-' + step, object: 'chat.completion.chunk', created: 1, model: 'gate-test' };
      send({ ...base, choices: [{ index: 0, delta: current ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + step, type: 'function', function: { name: current[0], arguments: JSON.stringify(current[1]) } }] } : { role: 'assistant', content: 'Read the live publisher page.' }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: current ? 'tool_calls' : 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (!('id' in input)) { res.writeHead(202).end(); return; }
    let result = {};
    if (input.method === 'initialize') result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' } };
    if (input.method === 'tools/list') result = { tools: [{ name: 'browser_navigate', description: 'Navigate to a website and read its live snapshot.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } }] };
    if (input.method === 'tools/call') {
      toolCalls.push(input.params);
      result = failNext ? { isError: true, content: [{ type: 'text', text: 'temporary service failure' }] }
        : { content: [{ type: 'text', text: 'LIVE SNAPSHOT: Five current article titles with links.' }] };
      failNext = false;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let session;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_MCP_CONFIG = path.join(dir, 'mcp.json');
    await fs.writeFile(process.env.PI_MCP_CONFIG, JSON.stringify({ mcpServers: { playwright: { url: baseUrl + '/mcp', lifecycle: 'lazy', requestTimeoutMs: 3000 } }, settings: { hostConfigDiscovery: 'off' } }));
    await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: { mock: { api: 'openai-completions', baseUrl: baseUrl + '/v1', apiKey: 'mock', models: [{ id: 'gate-test', contextWindow: 32000, maxTokens: 1000, reasoning: false, input: ['text'] }] } } }));
    const settingsManager = SettingsManager.inMemory({ defaultProvider: 'mock', defaultModel: 'gate-test', defaultTools: ALLOWED_TOOLS, extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool-search', '-builtin:llama.cpp'], retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, additionalExtensionPaths: [process.env.PI_MCP_TEST_EXTENSION || fileURLToPath(new URL('../index.ts', import.meta.url))] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(dir) }));
    const errors = [];
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    await session.prompt('Read five current headlines from a publisher.');
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 6);
    for (const request of requests) assert.deepEqual(request.tools.map(t => t.function.name).sort(), [...ALLOWED_TOOLS].sort());
    const searchTool = requests[0].tools.find(t => t.function.name === 'mcp_search');
    assert.ok(searchTool, 'mcp_search schema is exposed');
    assert.match(searchTool.function.description, /server=security/);
    assert.match(searchTool.function.description, /hasMore\/nextOffset/);
    assert.match(searchTool.function.description, /Validate schema fit/);
    assert.equal(toolCalls.length, 1, 'only the correctly validated, discovered call reaches MCP');
    assert.equal(toolCalls[0].name, 'browser_navigate');
    assert.deepEqual(toolCalls[0].arguments, { url: 'https://example.com' });
    const results = session.state.messages.filter(m => m.role === 'toolResult');
    assert.equal(results.length, 5);
    assert.equal(results[0].isError, true);
    assert.equal(results[1].isError, false);
    assert.equal(results[2].isError, true);
    assert.equal(results[3].isError, true);
    assert.equal(results[4].isError, false);
    assert.doesNotMatch(JSON.stringify(results[3].content), /already failed/);
    // Follow-ups retain discovery; identical successful output is not an error.
    const repeat = ['mcp_call', { tool: 'playwright_browser_navigate', args: { url: 'https://example.com' } }];
    scripted.push(repeat, repeat, repeat);
    await session.prompt('Read it again.');
    assert.equal(toolCalls.length, 4);
    assert.ok(session.state.messages.filter(m => m.role === 'toolResult').slice(-3).every(m => !m.isError));
    // A failed execution is reported, and one explicit retry reaches MCP.
    failNext = true;
    scripted.push(repeat, repeat);
    await session.prompt('Check the page; retry once if the service is temporarily unavailable.');
    assert.equal(toolCalls.length, 6);
    const retried = session.state.messages.filter(m => m.role === 'toolResult').slice(-2);
    assert.equal(retried[0].isError, true);
    assert.match(JSON.stringify(retried[0].content), /temporary service failure/);
    assert.equal(retried[1].isError, false);
    // Reinitialize the real adapter/gate from the active branch as on resume.
    await session.extensionRunner.emit({ type: 'session_start', reason: 'reload' });
    scripted.push(repeat);
    await session.prompt('Read it after reload.');
    assert.equal(toolCalls.length, 7);
    assert.equal(session.state.messages.filter(m => m.role === 'toolResult').at(-1).isError, false);
    // Going back before discovery cannot inherit grants from an abandoned branch.
    const firstUser = session.sessionManager.getBranch().find(e => e.type === 'message' && e.message.role === 'user');
    await session.navigateTree(firstUser.id);
    scripted.push(repeat);
    await session.prompt('Read it in this new branch.');
    assert.equal(toolCalls.length, 7);
    const latest = session.state.messages.filter(m => m.role === 'toolResult').at(-1);
    assert.equal(latest.isError, true);
    assert.match(JSON.stringify(latest.content), /not discovered/);
    for (const request of requests) assert.deepEqual(request.tools.map(t => t.function.name).sort(), [...ALLOWED_TOOLS].sort());
  } finally {
    if (session) { await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
    if (oldConfig === undefined) delete process.env.PI_MCP_CONFIG; else process.env.PI_MCP_CONFIG = oldConfig;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
