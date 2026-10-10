import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function readJson(file, missing = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(missing); throw error; }
}

export async function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  try { if (await fs.readFile(file, 'utf8') === text) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } finally { await fs.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return true;
}

export function integer(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  return n;
}

export async function loadSdk(root = process.env.PI_SDK_ROOT || '/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent') {
  return import(pathToFileURL(path.join(root, 'dist/index.js')));
}

export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(url)) === realpathSync(path.resolve(process.argv[1])); }
  catch { return false; }
}
