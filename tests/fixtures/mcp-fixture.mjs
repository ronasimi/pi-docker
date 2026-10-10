import readline from 'node:readline';
const server = process.argv[2];
const tool = server === 'memory' ? 'search_nodes' : 'inspect_state';
const count = Number(process.argv[3] || 1);
for await (const line of readline.createInterface({ input: process.stdin })) {
  let req; try { req = JSON.parse(line); } catch { continue; }
  if (req.id === undefined) continue;
  let result;
  if (req.method === 'initialize') result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: server, version: '1.0' } };
  else if (req.method === 'tools/list') result = { tools: Array.from({ length: count }, (_, index) => ({ name: index === 0 ? tool : `${tool}_${index}`, description: `${server} ${tool}: search or inspect project data ${index}`, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } })) };
  else if (req.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ query: req.params.arguments.query, count: 0 }) }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
}
