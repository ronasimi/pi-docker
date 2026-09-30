import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
const webDir = process.env.PI_WEB_DATA_DIR || '/home/pi/.pi-web';
const webPackage = process.env.PI_WEB_PACKAGE_DIR || '/usr/local/lib/node_modules/pi-web-ui';
const extension = process.env.PI_MCP_GATE_PATH || '/opt/pi-mcp-gate/index.ts';
const { AGENT_TOOL_CATALOG } = await import(pathToFileURL(path.join(webPackage, 'dist/server/tool-manager.js')));
const optional = AGENT_TOOL_CATALOG.map(t => t.name);
function update(file, transform) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let value = {};
  if (fs.existsSync(file)) {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fs.existsSync(file + '.before-mcp-gate')) fs.copyFileSync(file, file + '.before-mcp-gate');
  }
  transform(value);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
update(path.join(agentDir, 'settings.json'), settings => {
  settings.defaultTools = ['read', 'write', 'edit', 'bash', 'mcp_search', 'mcp_call'];
  // Preserve installed packages and themes; deactivate their optional resources.
  settings.packages = (settings.packages ?? []).map(p => ({ ...(typeof p === 'string' ? { source: p } : p), extensions: [], skills: [], prompts: [] }));
  settings.extensions = ['-builtin:mcp', '-builtin:codemode', '-builtin:tool-search', '-builtin:llama.cpp', extension];
});
update(path.join(webDir, 'client-state.json'), state => {
  // Settings are global in 0.96.1, but also migrate older per-client records and presets.
  state.__settings__ ??= { projects: [] };
  for (const value of Object.values(state)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    value.settings ??= {};
    for (const settings of [value.settings, ...(value.presets ?? [])]) {
      settings.disabledAgentTools = [...optional];
      settings.terminalToolsEnabled = false;
      settings.editSoftEnabled = false;
      settings.questionnaireEnabled = false;
      settings.terminalBash = false;
      // Keep permission presets, model settings, chats, and custom prompts intact.
    }
  }
});
console.log(`[pi] Core tools + bounded MCP enabled; ${optional.length} optional Web UI tools disabled.`);
