/** Stable Pi prompt invariants. Descriptive prose may change without breaking builds. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUIRED_PERMANENT_TOOLS = Object.freeze([
  'read', 'bash', 'edit', 'write', 'tool_search', 'tool_invoke', 'result_get', 'result_list',
]);

export function promptContractFailures(prompt) {
  if (typeof prompt !== 'string') return ['Prompt is not text'];
  const errors = [];
  const normalized = prompt.toLowerCase();
  if (Buffer.byteLength(prompt, 'utf8') > 4095) errors.push('Standing prompt exceeds 4095-byte limit');
  for (const tool of REQUIRED_PERMANENT_TOOLS) {
    if (!new RegExp(`\\b${tool}\\b`, 'i').test(prompt)) errors.push(`Missing permanent tool ${tool}`);
  }
  // Check the *behavioral* contract, not brittle text such as "NEXT call ...".
  if (!/schema cache holds nine entries/i.test(prompt) || !/discovery grants survive cache eviction/i.test(prompt)) errors.push('Missing bounded schema cache and persistent discovery grants');
  const direct = /\b(?:directly|direct\s+tools?)\b/i.test(prompt) && /\bresult_get\b/i.test(prompt) && /\bresult_list\b/i.test(prompt);
  if (!direct) errors.push('Archived result tools must be used directly');
  const readyInvocation = /\b(?:ready|reused)\b[\s\S]{0,180}\b(?:invoke|tool_invoke)\b/i.test(prompt)
    || /\b(?:invoke|tool_invoke)\b[\s\S]{0,180}\b(?:ready|reused)\b/i.test(prompt);
  if (!readyInvocation) errors.push('No instruction to invoke a relevant ready/reused deferred operation');
  if (!/\bunavailable\b/i.test(normalized)) errors.push('Missing unavailable-capability handling');
  if (!/\b(?:passive|active)\b/i.test(normalized)) errors.push('Missing network authorization guidance');
  if (!/\bevidence\b/i.test(normalized)) errors.push('Missing evidence-grounding guidance');
  return errors;
}

export function validatePromptFiles(primary, secondary = null) {
  const a = readFileSync(primary, 'utf8');
  const errors = promptContractFailures(a).map(x => `${primary}: ${x}`);
  if (secondary) {
    const b = readFileSync(secondary, 'utf8');
    errors.push(...promptContractFailures(b).map(x => `${secondary}: ${x}`));
    if (a !== b) errors.push('Primary and extension APPEND_SYSTEM prompts diverged');
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const ix = args.indexOf('--prompt');
  const ixSecondary = args.indexOf('--secondary');
  if (ix === -1 || !args[ix + 1]) {
    console.error('Usage: node check-prompt-contract.mjs --prompt PATH [--secondary PATH]');
    process.exitCode = 2;
  } else {
    try {
      const errors = validatePromptFiles(args[ix + 1], ixSecondary < 0 ? null : args[ixSecondary + 1]);
      if (errors.length) { console.error('Pi prompt contract FAILED:\n' + errors.map(e => ` - ${e}`).join('\n')); process.exitCode = 1; }
      else console.log('Pi prompt contract: PASS (semantic invariant checks)');
    } catch (err) { console.error('Pi prompt contract FAILED:', err.message); process.exitCode = 2; }
  }
}
