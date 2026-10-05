import assert from 'node:assert/strict';
import test from 'node:test';
import guard from '../config/extensions/tool-search-default-limit.js';

function install() {
  let handler;
  guard({
    on(event, callback) {
      assert.equal(event, 'tool_call');
      handler = callback;
    },
  });
  assert.equal(typeof handler, 'function');
  return handler;
}

test('omitted tool_search.limit is normalized to 1', () => {
  const handler = install();
  const event = {toolName: 'tool_search', input: {query: 'get_host_interface_info'}};
  handler(event);
  assert.deepEqual(event.input, {query: 'get_host_interface_info', limit: 1});
});

test('explicit tool_search.limit is preserved', () => {
  const handler = install();
  const event = {toolName: 'tool_search', input: {query: 'network assessment', limit: 3}};
  handler(event);
  assert.equal(event.input.limit, 3);
});

test('non-tool_search calls are untouched', () => {
  const handler = install();
  const event = {toolName: 'read', input: {path: 'README.md'}};
  handler(event);
  assert.deepEqual(event.input, {path: 'README.md'});
});
