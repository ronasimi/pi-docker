#!/usr/bin/env node
import { alias32k, modelIdentity, configuredContext, nativeContext, CONTEXT_CAP } from './model-policy.mjs';
import { isMain, writeJson } from './config-common.mjs';

export async function configureAliases({ baseUrl, fetchImpl = fetch, timeoutMs = 120000, manifestPath } = {}) {
  baseUrl = (baseUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const request = async (endpoint, body) => {
    const response = await fetchImpl(`${baseUrl}/api/${endpoint}`, {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Ollama ${endpoint}: HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`Ollama ${endpoint}: ${data.error}`);
    return data;
  };
  const tags = await request('tags');
  const groups = new Map();
  for (const model of tags.models || []) {
    if (!model.name) continue;
    const identity = modelIdentity(model.name);
    const group = groups.get(identity) || [];
    group.push(model.name); groups.set(identity, group);
  }
  const aliases = {}, skipped = [];
  for (const [identity, names] of groups) {
    const target = alias32k(identity);
    const source = names.find(n => n === identity) || names.find(n => !/-\d+k(?::.*)?$/i.test(n)) || names[0];
    const show = await request('show', { model: source });
    const capabilities = show.capabilities || [];
    if (capabilities.includes('embedding') && !capabilities.includes('completion')) {
      skipped.push({ model: source, reason: 'embedding model' }); continue;
    }
    if (!capabilities.includes('completion')) {
      skipped.push({ model: source, reason: 'completion capability not verified' }); continue;
    }
    if (show.remote_host || show.remote_model) {
      skipped.push({ model: source, reason: 'remote model allocation managed by its server' }); continue;
    }
    const limit = nativeContext(show, 0);
    if (!limit || limit < CONTEXT_CAP) {
      skipped.push({ model: source, reason: limit ? `native limit ${limit}` : 'native context limit not verified' }); continue;
    }
    const existing = names.includes(target) ? await request('show', { model: target }) : undefined;
    if (configuredContext(existing) !== CONTEXT_CAP) {
      if (target === source) throw new Error(`Cannot repair ${target} without a distinct source model`);
      const created = await request('create', { model: target, from: source, parameters: { num_ctx: CONTEXT_CAP }, stream: false });
      if (created.status !== 'success') throw new Error(`Ollama did not confirm creation of ${target}`);
    }
    const verified = await request('show', { model: target });
    if (configuredContext(verified) !== CONTEXT_CAP) throw new Error(`${target}: num_ctx verification failed`);
    for (const key of ['template', 'system', 'renderer', 'parser']) {
      if (show[key] !== undefined && verified[key] !== show[key]) throw new Error(`${target}: inherited ${key} changed`);
    }
    for (const name of names) aliases[name] = target;
    aliases[identity] = target;
    console.error(`[pi] Verified ${target}: num_ctx=${CONTEXT_CAP}`);
  }
  const manifest = { version: 1, contextWindow: CONTEXT_CAP, aliases, skipped };
  if (manifestPath) await writeJson(manifestPath, manifest);
  for (const item of skipped) console.error(`[pi] Skipped ${item.model}: ${item.reason}`);
  return manifest;
}

if (isMain(import.meta.url)) configureAliases({ manifestPath: process.env.PI_ALIAS_MANIFEST || 'data/pi/agent/model-aliases-32k.json' })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
