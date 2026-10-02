import test from 'node:test';
import assert from 'node:assert/strict';
import { THINKING_CONTINUATION_MESSAGE, WORKFLOW_CONTINUATION_LIMIT, isThinkingOnlyAssistant, thinkingOnlyBoundaryResult, workflowContinuationBoundaryResult } from '../runtime-guards.mjs';

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
    context: { canContinue: false, contextMessages: [{ role: 'user', content: [{ type: 'text', text: 'make a map' }] }, thinking()] },
  };
  const result = thinkingOnlyBoundaryResult(event, false);
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].type, 'custom_message');
  assert.equal(result.entries[0].display, false);
  assert.equal(result.entries[0].content, THINKING_CONTINUATION_MESSAGE);
  assert.equal(event.context.canContinue, false, 'pre-draft boundary is expected to be non-continuable when the last role is assistant');
  assert.equal(thinkingOnlyBoundaryResult(event, true), undefined, 'automatic continuation is capped at one per agent run');
});

test('does not continue aborted/error or ordinary completed answers', () => {
  const base = { entries: [], context: { canContinue: false, contextMessages: [thinking()] } };
  assert.equal(thinkingOnlyBoundaryResult({ ...base, outcome: 'aborted' }, false), undefined);
  assert.equal(thinkingOnlyBoundaryResult({ ...base, outcome: 'error' }, false), undefined);
  assert.equal(thinkingOnlyBoundaryResult({ outcome: 'completed', entries: [], context: { canContinue: true, contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }], stopReason: 'stop' }] } }, false), undefined);
});


test('incomplete network workflow settlement is continued before finalization', () => {
  const event = {
    outcome: 'completed',
    entries: [],
    context: { contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Partial final answer.' }], stopReason: 'stop' }] },
  };
  const status = [
    { stage: 'host network state', tool: 'security_get_host_interface_info', query: 'host network interface state', status: 'completed', discovered: true },
    { stage: 'network discovery and enumeration', tool: 'security_perform_network_discovery', query: 'comprehensive network discovery', status: 'outstanding', discovered: false },
    { stage: 'network topology', tool: 'security_analyze_network_topology', query: 'network topology analysis', status: 'outstanding', discovered: true },
  ];
  const result = workflowContinuationBoundaryResult(event, status, 0);
  assert.equal(result.continue, true);
  assert.equal(result.entries[0].display, false);
  assert.match(result.entries[0].content, /network discovery and enumeration/);
  assert.match(result.entries[0].content, /mcp_search/);
  assert.match(result.entries[0].content, /comprehensive network discovery/);
});

test('workflow continuation stops when all stages are complete/unavailable or guard cap is reached', () => {
  const event = { outcome: 'completed', entries: [], context: {} };
  assert.equal(workflowContinuationBoundaryResult(event, [
    { stage: 'wireless', status: 'unavailable' },
    { stage: 'map', status: 'completed' },
  ], 0), undefined);
  assert.equal(workflowContinuationBoundaryResult(event, [
    { stage: 'map', tool: 'security_generate_graphical_network_map', query: 'graphical network map', status: 'outstanding', discovered: true },
  ], WORKFLOW_CONTINUATION_LIMIT), undefined);
});
