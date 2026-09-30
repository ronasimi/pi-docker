// Build-time patch against the pinned Web UI. Fail visibly on upstream changes.
// This is a tool allowlist, layered underneath existing permission/preset checks.
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Usage: node patch-web-tool-policy.mjs <pi-web-ui package directory>');
const file = path.join(root, 'dist/server/tool-manager.js');
let source = fs.readFileSync(file, 'utf8');
if (!source.includes('PI_BOUNDED_MCP_POLICY')) {
  const replacements = [
    ['return AGENT_TOOL_CATALOG.filter((t) => !t.defaultOn).map((t) => t.name);', 'return AGENT_TOOL_CATALOG.map((t) => t.name);'],
    ['const all = Array.from(tools);', 'const all = Array.from(tools).filter((name) => PI_BOUNDED_MCP_POLICY.has(name));'],
    ['session.setActiveToolsByName([...names]);', 'session.setActiveToolsByName([...names].filter((name) => PI_BOUNDED_MCP_POLICY.has(name)));'],
    ['session.setActiveToolsByName([...active]);', 'session.setActiveToolsByName([...active].filter((name) => PI_BOUNDED_MCP_POLICY.has(name)));'],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Unsupported Web UI tool-manager layout: ${before}`);
    source = source.replace(before, after);
  }
  source = 'const PI_BOUNDED_MCP_POLICY = new Set(["read", "write", "edit", "bash", "mcp_search", "mcp_call"]);\n' + source;
  fs.writeFileSync(file, source);
}
console.log('[pi] Web UI tool allowlist applied.');
