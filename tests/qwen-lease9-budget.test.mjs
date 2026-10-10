import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const scripts = process.env.PI_TEST_SCRIPTS_DIR || path.join(root,'scripts');
const extension = process.env.PI_ATOMIC_EXTENSION_PATH || path.join(root,'extensions/pi-atomic-tool-results');
const { schemaBudget } = await import(pathToFileURL(path.join(scripts,'probe-qwen-trial.mjs')));
const { loadConfig } = await import(pathToFileURL(path.join(extension,'lib/config.js')));
const buffered = n => Array.from({length:n},(_,i)=>`tool_${i}`);
const req = (n, names=buffered(n)) => ({ messages: [{role:'tool',tool_call_id:'lease', content: JSON.stringify({ discovery:'ready',tools:[{name:'tool_1',parameters:{type:'object'}}],buffered:names})}] });

test('Qwen SDK schema budget agrees with nine-slot runtime without changing per-search schema cap', () => {
  assert.equal(loadConfig().leaseCapacity, 9);
  assert.equal(loadConfig().maxSchemas, 1);
  assert.deepEqual(schemaBudget([req(9)]), {maxSchemaCount:1,maxSchemasPerDiscovery:1,maxBufferedTools:9});
  assert.throws(()=>schemaBudget([req(10)]),/exceeded nine distinct tools/);
  assert.throws(()=>schemaBudget([req(2,['duplicate','duplicate'])]),/exceeded nine distinct tools/);
});

test('Qwen probe allows eight historic discoveries without treating history as live declarations', () => {
  const rounds=Array.from({length:8},(_,i)=>req(i+1));
  const budget=schemaBudget(rounds);
  assert.equal(budget.maxBufferedTools, 8);
  assert.equal(budget.maxSchemasPerDiscovery,1);
  assert.equal(budget.maxSchemaCount,1);
});

test('Qwen activation validator agrees with nine-slot limit', () => {
  const source=fs.readFileSync(path.join(scripts,'configure-qwen-trial.py'),'utf8');
  assert.match(source,/not 1 <= case\['maxBufferedTools'\] <= 9/);
  assert.match(source,/FIFO-9 schema budget/);
});
