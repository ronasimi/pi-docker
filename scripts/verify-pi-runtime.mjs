import fs from 'node:fs';
import path from 'node:path';

const PI_DIR = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent';
const WEB_DIR = '/usr/local/lib/node_modules/pi-web-ui';
const NESTED_PI_DIR = path.join(WEB_DIR, 'node_modules/@earendil-works/pi-coding-agent');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function versionTuple(value) {
  const m = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`invalid semantic version: ${value}`);
  return m.slice(1).map(Number);
}

function gte(actual, minimum) {
  const a = versionTuple(actual), b = versionTuple(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function containsText(root, needle) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git'].includes(entry.name)) stack.push(full);
        continue;
      }
      if (!/\.(?:js|mjs|cjs|ts|d\.ts)$/.test(entry.name)) continue;
      try {
        if (fs.readFileSync(full, 'utf8').includes(needle)) return full;
      } catch { /* ignore unreadable generated assets */ }
    }
  }
  return null;
}

const pi = readJson(path.join(PI_DIR, 'package.json'));
const nestedPi = readJson(path.join(NESTED_PI_DIR, 'package.json'));
const web = readJson(path.join(WEB_DIR, 'package.json'));

if (!gte(pi.version, '1.0.0')) {
  throw new Error(`Pi ${pi.version} is too old: bounded MCP settle guards require Pi >= 1.0.0`);
}
if (nestedPi.version !== pi.version) {
  throw new Error(`Pi version mismatch: global=${pi.version}, pi-web-ui nested=${nestedPi.version}`);
}
if (!gte(web.version, '0.97.0')) {
  throw new Error(`pi-web-ui ${web.version} is too old for this image; require >= 0.97.0`);
}

const boundarySource = containsText(path.join(PI_DIR, 'dist'), 'agent_before_settle');
if (!boundarySource) {
  throw new Error(`Pi ${pi.version} does not expose agent_before_settle in its installed runtime`);
}

const toolManager = path.join(WEB_DIR, 'dist/server/tool-manager.js');
if (!fs.existsSync(toolManager)) {
  throw new Error(`pi-web-ui tool manager not found: ${toolManager}`);
}
const toolManagerSource = fs.readFileSync(toolManager, 'utf8');
if (!toolManagerSource.includes('AGENT_TOOL_CATALOG')) {
  throw new Error('pi-web-ui tool-manager no longer exposes AGENT_TOOL_CATALOG; update configure-tool-policy.mjs before upgrading');
}

console.log(`[pi] runtime compatibility verified: Pi ${pi.version}, pi-web-ui ${web.version}, agent_before_settle=${path.relative(PI_DIR, boundarySource)}`);
console.log('[pi] bounded tool policy is enforced by the Pi extension/settings layer; no pi-web-ui source patch is required.');
