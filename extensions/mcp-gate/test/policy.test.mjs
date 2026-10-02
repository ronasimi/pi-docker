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
  assert.match(prompt, /dedicated wireless search\/call/i);
  assert.match(prompt, /different workspaces/i);
  assert.match(prompt, /direct `data`/i);
});

test('image pins upstream Pi with actionable settle boundary and does not patch pi-web-ui source', async () => {
  const dockerfile = await fs.readFile(fileURLToPath(new URL('../../../Dockerfile', import.meta.url)), 'utf8');
  assert.match(dockerfile, /ARG PI_VERSION=1\.0\.0/);
  assert.match(dockerfile, /ARG PI_WEB_UI_VERSION=0\.97\.0/);
  assert.doesNotMatch(dockerfile, /patch-web-tool-policy/);
  assert.match(dockerfile, /verify-pi-runtime\.mjs/);
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
