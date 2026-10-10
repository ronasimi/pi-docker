#!/usr/bin/env node
// Prepare a one-process Pi config: do not edit the persistent Web UI settings.
import fs from 'node:fs';
import path from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: diagnostic-trial-config.mjs <source-config-dir> <temporary-config-dir>');
const src = path.resolve(source), dest = path.resolve(destination);
if (src === dest || !dest.startsWith('/tmp/pi-schema-trial-')) throw new Error('Refusing non-temporary diagnostic target');
if (!fs.statSync(dest).isDirectory()) throw new Error('Temporary directory missing');
const read = file => JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(dest, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const settings = read('settings.json');
const models = read('models.json');

const trigger = 24576, contextWindow = 32768, reserveTokens = contextWindow - trigger;
const compaction = { ...(settings.compaction ?? {}), enabled: true, reserveTokens, keepRecentTokens: 4096 };
const overrides = { ...(compaction.modelOverrides ?? {}) };
let updated = 0;
// Existing per-model overrides supersede ordinary settings; update the 32K
// aliases explicitly, leaving smaller models' trigger values unchanged.
for (const [provider, config] of Object.entries(models.providers ?? {})) {
  for (const model of config.models ?? []) {
    const id = model.id;
    if (!id) continue;
    const key = `${provider}/${id}`;
    const actualWindow = Number(config.modelOverrides?.[id]?.contextWindow ?? model.contextWindow ?? 0);
    if (actualWindow >= contextWindow) {
      overrides[key] = { ...(overrides[key] ?? {}), reserveTokens, keepRecentTokens: 4096 };
      updated++;
    }
  }
  // Some configured models exist only as provider overrides. If their context
  // window is known, they still need the isolated compaction override.
  for (const [id, meta] of Object.entries(config.modelOverrides ?? {})) {
    const key = `${provider}/${id}`;
    if (Number(meta?.contextWindow ?? 0) >= contextWindow && !(key in overrides)) {
      overrides[key] = { reserveTokens, keepRecentTokens: 4096 };
      updated++;
    }
  }
}
compaction.modelOverrides = overrides;
settings.compaction = compaction;
write('settings.json', settings);
write('models.json', models);
for (const file of ['models-store.json', 'model-aliases-32k.json', 'auth.json', 'mcp.json']) {
  const from = path.join(src, file);
  if (fs.existsSync(from) && fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dest, file));
}
const promptPath = path.join(src, 'APPEND_SYSTEM.md');
const originalPrompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';
// Avoid contradictory production-only FIFO/limit wording inside this isolated trial.
const prompt = originalPrompt
  .replace(/The five most recently discovered distinct operations are available in a FIFO; this is for recovery, not bulk discovery\. Reuse a buffered tool instead of searching again\. Rediscover after eviction or schema change\./g,
    'Previously discovered registered operations remain callable for this diagnostic run. Reuse an already discovered operation; rediscover only after a schema change or loss of visible schema evidence.')
  .replace(/discover with `tool_search` using a specific server and verb, `limit: 1`\./g,
    'discover with `tool_search` using a specific server and verb. Default to `limit: 1`; increase it only for a specific comparison of ranking behavior.');
const strictPrompt = `# Strict single-run tool execution protocol

This is a LIVE CLI diagnostic with unbounded Pi-side discovery grants, a 24K compaction trigger, and a fixed provider tool prefix. This instruction has priority over any older schema-cache guidance below. All other security and permission constraints remain active.

**MANDATORY TOOL-SEQUENCE RULE:** After EVERY successful \`tool_search\` response that provides a relevant executable tool, your NEXT tool action MUST be exactly one structured \`tool_invoke\` call using an exact discovered name and concrete arguments satisfying the returned parameter schema. No intervening \`tool_search\`, inventory gathering, multiple discovery calls, unrelated tools or textual \`call:...\` imitations. A single search can return multiple candidates; choose the best match and invoke it before searching again. More available schemas are not an invitation to prefetch.

If discovery returns zero applicable operations or only an inapplicable/dangerous operation: do not invoke it. Say what made it unusable in your working notes, then make ONE narrowly refined discovery or report the limitation. Never invent arguments. An execution error is not permission to retry unchanged; inspect the returned error, correct the input or switch tasks. Do not invoke destructive/write operations unless explicitly authorized by the user's request.

Do not place JSON Schema metadata such as \`{\"type\":\"object\"}\` in invocation arguments. Use the actual parameter values. Reuse an already discovered tool without searching again when its schema is still visible. Previously discovered tools remain authorized without FIFO eviction for this run, subject to registration, schema integrity and normal permissions. After calling a tool, consume its result and proceed; avoid full evidence rehydration unless a specific missing field is needed.

The goal is to *observe the model's behavior live*, not to pretend success. Expose normal thinking/text/tool activity through Pi CLI and report actual tool errors. Do not modify credentials, config, router state or services as part of this diagnostic unless the user specifically requests it.
`;
fs.writeFileSync(path.join(dest, 'APPEND_SYSTEM.md'), `${strictPrompt}\n${prompt}`, { mode: 0o600 });
console.log(`Diagnostic: compaction at ${trigger}/${contextWindow} tokens (reserve ${reserveTokens}, retain recent 4096); updated ${updated} model entries; production unchanged. Strict search-then-invoke prompt active.`);
