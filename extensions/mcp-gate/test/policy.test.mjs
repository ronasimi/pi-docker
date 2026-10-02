import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ALLOWED_TOOLS } from '../gate.mjs';
const webPackage = process.env.PI_WEB_PACKAGE_DIR;
const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));


test('system prompt enforces multi-step completion and evidence grounding', async () => {
  const promptPath = fileURLToPath(new URL('../../../config/APPEND_SYSTEM.md', import.meta.url));
  const prompt = await fs.readFile(promptPath, 'utf8');
  assert.match(prompt, /## Multi-step MCP completion/);
  assert.match(prompt, /never a complete server catalog/i);
  assert.match(prompt, /Search each still-outstanding capability separately before finalizing/i);
  assert.match(prompt, /## Evidence grounding/);
  assert.match(prompt, /Unknown stays unknown/i);
  assert.match(prompt, /do not infer a remote host's wired\/wireless attachment/i);
  assert.match(prompt, /HE\/NSS\/GI are PHY fields/i);
  assert.match(prompt, /runtime blocks that no-progress loop/i);
  assert.match(prompt, /emit the tool call immediately/i);
});

test('published Web UI allowlist preserves restrictive presets and blocks optional reactivation', { skip: !webPackage }, async () => {
  const { applyAgentToolsGating, setAgentToolEnabled, defaultDisabledAgentTools, AGENT_TOOL_CATALOG, filterToolsByPreset } = await import(pathToFileURL(path.join(webPackage, 'dist/server/tool-manager.js')));
  let active = [...ALLOWED_TOOLS, 'browser_page', 'searxng_search', 'mcpScript'];
  const session = { getAllTools: () => active.map(name => ({ name })), getActiveToolNames: () => active, setActiveToolsByName: names => { active = names; } };
  applyAgentToolsGating(session, []);
  assert.deepEqual([...active].sort(), [...ALLOWED_TOOLS].sort());
  setAgentToolEnabled(session, 'browser_page', true);
  assert.ok(!active.includes('browser_page'));
  assert.equal(defaultDisabledAgentTools().length, AGENT_TOOL_CATALOG.length);
  assert.deepEqual(filterToolsByPreset(ALLOWED_TOOLS, 'ask'), []);
  assert.deepEqual(filterToolsByPreset(ALLOWED_TOOLS, 'minimal').sort(), ['bash', 'read']);
});
test('migration preserves model/permission settings and sessions, disables installed extras, and is idempotent', { skip: !webPackage }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-policy-'));
  const agent = path.join(dir, 'agent');
  const web = path.join(dir, 'web');
  try {
    await fs.mkdir(agent); await fs.mkdir(web);
    const settings = { defaultModel: 'gemma', packages: ['npm:pi-mcp-adapter'], extensions: ['extra.ts'] };
    const state = { __settings__: { settings: { defaultPermissionPreset: 'read-only', customSystemPrompt: 'keep me' } }, client: { sessions: ['abc'], projects: ['/workspace'] } };
    await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify(settings));
    await fs.writeFile(path.join(web, 'client-state.json'), JSON.stringify(state));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_DATA_DIR: web, PI_WEB_PACKAGE_DIR: webPackage };
    for (let n = 0; n < 2; n++) {
      const result = spawnSync(process.execPath, [path.join(scripts, 'configure-tool-policy.mjs')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const updated = JSON.parse(await fs.readFile(path.join(agent, 'settings.json')));
    const migrated = JSON.parse(await fs.readFile(path.join(web, 'client-state.json')));
    assert.equal(updated.defaultModel, 'gemma');
    assert.deepEqual(updated.packages[0].extensions, []);
    assert.deepEqual(updated.defaultTools, ALLOWED_TOOLS);
    assert.equal(migrated.__settings__.settings.defaultPermissionPreset, 'read-only');
    assert.equal(migrated.__settings__.settings.customSystemPrompt, 'keep me');
    assert.ok(migrated.__settings__.settings.disabledAgentTools.includes('browser_page'));
    assert.deepEqual(migrated.client.sessions, ['abc']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(agent, 'settings.json.before-mcp-gate'))), settings);
    // Corrupt state fails without overwriting it.
    await fs.writeFile(path.join(agent, 'settings.json'), '{bad');
    const bad = spawnSync(process.execPath, [path.join(scripts, 'configure-tool-policy.mjs')], { env, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'), '{bad');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
