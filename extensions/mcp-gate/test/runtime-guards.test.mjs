import test from 'node:test';
import assert from 'node:assert/strict';
import { THINKING_CONTINUATION_MESSAGE, isThinkingOnlyAssistant, thinkingOnlyBoundaryResult } from '../runtime-guards.mjs';

const thinking = (text = 'I should call the discovered map tool now.') => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking: text }],
  stopReason: 'stop',
});

test('detects a thinking-only assistant stop but not visible text or tool calls', () => {
  assert.equal(isThinkingOnlyAssistant(thinking()), true);
  assert.equal(isThinkingOnlyAssistant({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' }), false);
  assert.equal(isThinkingOnlyAssistant({ role: 'assistant', content: [{ type: 'thinking', thinking: 'call it' }, { type: 'toolCall', name: 'mcp_call', arguments: {} }], stopReason: 'toolUse' }), false);
  assert.equal(isThinkingOnlyAssistant({ role: 'assistant', content: [{ type: 'thinking', thinking: '' }], stopReason: 'stop' }), false);
});

test('thinking-only settlement injects one hidden continuation message', () => {
  const event = {
    outcome: 'completed',
    entries: [],
    context: { canContinue: true, contextMessages: [{ role: 'user', content: [{ type: 'text', text: 'make a map' }] }, thinking()] },
  };
  const result = thinkingOnlyBoundaryResult(event, false);
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].type, 'custom_message');
  assert.equal(result.entries[0].display, false);
  assert.equal(result.entries[0].content, THINKING_CONTINUATION_MESSAGE);
  assert.equal(thinkingOnlyBoundaryResult(event, true), undefined, 'automatic continuation is capped at one per agent run');
});

test('does not continue aborted/error or ordinary completed answers', () => {
  const base = { entries: [], context: { canContinue: true, contextMessages: [thinking()] } };
  assert.equal(thinkingOnlyBoundaryResult({ ...base, outcome: 'aborted' }, false), undefined);
  assert.equal(thinkingOnlyBoundaryResult({ ...base, outcome: 'error' }, false), undefined);
  assert.equal(thinkingOnlyBoundaryResult({ outcome: 'completed', entries: [], context: { canContinue: true, contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }], stopReason: 'stop' }] } }, false), undefined);
});
