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


test('get_host_interface_info drops null optional interface so auto-selection receives {}',()=>{
  const handler=install();
  const event={toolName:'mcp__security__get_host_interface_info',input:{interface:null}};
  handler(event);
  assert.deepEqual(event.input,{});
});

test('get_host_interface_info preserves explicit interface',()=>{
  const handler=install();
  const event={toolName:'mcp__security__get_host_interface_info',input:{interface:'wlp3s0'}};
  handler(event);
  assert.deepEqual(event.input,{interface:'wlp3s0'});
});
