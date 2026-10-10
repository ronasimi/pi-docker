import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const configDir = process.env.PI_DEFAULT_CONFIG_DIR || path.resolve(dir, '..', 'config');
const extDir = process.env.PI_ATOMIC_EXTENSION_PATH || path.resolve(dir, '..', 'extensions', 'pi-atomic-tool-results');
const scriptsDir = process.env.PI_TEST_SCRIPTS_DIR || path.resolve(dir, '..', 'scripts');
const { promptContractFailures, validatePromptFiles } = await import(pathToFileURL(path.join(scriptsDir, 'check-prompt-contract.mjs')));
const prompt = readFileSync(path.join(configDir, 'APPEND_SYSTEM.md'), 'utf8');

test('both installed prompts meet shared behavioral contract', () => {
  assert.deepEqual(validatePromptFiles(path.join(configDir, 'APPEND_SYSTEM.md'), path.join(extDir, 'config', 'APPEND_SYSTEM.md')), []);
});

test('contract permits equivalent prose about ready tools', () => {
  const alternative = prompt.replace(/For `ready` or `reused`, inspect the schema and call `tool_invoke` with the exact operation name and concrete arguments\./,
    'When an operation is ready, tool_invoke executes it using the returned arguments.');
  assert.notEqual(alternative, prompt);
  assert.deepEqual(promptContractFailures(alternative), []);
});

test('contract rejects missing permanent direct result tool', () => {
  assert(promptContractFailures(prompt.replaceAll('result_list', 'archive_lister')).some(e => e.includes('result_list')));
});

test('contract rejects missing schema cache and grant separation', () => {
  assert(promptContractFailures(prompt.replace('discovery grants survive cache eviction', 'operations expire')).some(e => e.includes('schema cache')));
});

test('contract rejects missing authorization or evidence guidance', () => {
  assert(promptContractFailures(prompt.replaceAll(/evidence/gi, 'observations')).some(e => e.includes('evidence')));
});
