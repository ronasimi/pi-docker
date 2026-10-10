import test from 'node:test';
import assert from 'node:assert/strict';
import atomicToolResults from '../index.js';

// Reproduce the real r19/r20 upgrade case: a previously saved active-tool
// selection includes result_get but omits the newly permanent result_list.
function fixture() {
  const handlers = new Map(), registered = new Map(), entries = [];
  let active = ['tool_search', 'read'];
  let loaded = false;
  let attemptedDuringLoad = false;
  const api = {
    on(name, cb) { handlers.set(name, cb); },
    registerTool(tool) {
      registered.set(tool.name, tool);
      if (['direct', 'model-only'].includes(tool.exposure ?? 'direct') && tool.name !== 'result_list') active.push(tool.name);
    },
    registerCommand() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    getAllTools() { return [...registered.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { if (!loaded) { attemptedDuringLoad = true; throw new Error('Extension runtime not initialized. Action methods cannot be called during extension loading.'); } active = [...names]; },
  };
  for(const name of ['read','tool_search'])registered.set(name,{name,exposure:'direct',parameters:{type:'object',properties:{}}});
  registered.set('mcp__fixture__operation_0', { name: 'mcp__fixture__operation_0', exposure: 'deferred', description: 'Example fixture operation 0', parameters: {type:'object',properties:{}} });
  atomicToolResults(api);
  loaded = true;
  return { api, handlers, entries, active: () => active, attemptedDuringLoad: () => attemptedDuringLoad, ctx: {sessionManager:{getBranch:()=>entries}} };
}

test('restores result_list at session start without calling Pi action methods during loading', () => {
  const f = fixture();
  assert.equal(f.attemptedDuringLoad(), false);
  f.handlers.get('session_start')({}, f.ctx);
  const fixed = JSON.stringify(f.api.getActiveTools());
  assert.deepEqual(f.api.getActiveTools(), ['read', 'tool_search', 'tool_invoke', 'result_get', 'result_list']);
  for(let n = 0; n < 3; n++) {
    // Emulate native tool_search temporarily activating a deferred schema.
    f.api.setActiveTools([...f.api.getActiveTools(), 'mcp__fixture__operation_0']);
    f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:`s${n}`,input:{query:'mcp__fixture__operation_0'},details:{loaded:['mcp__fixture__operation_0']}, content:[{type:'text',text:'Loaded'}],isError:false}, f.ctx);
    assert.equal(JSON.stringify(f.api.getActiveTools()), fixed);
  }
});

test('restores direct results again on new session without growing the tool list', () => {
  const f = fixture();
  f.handlers.get('session_start')({}, f.ctx);
  const expected = f.api.getActiveTools();
  f.api.setActiveTools(expected.filter(n => n !== 'result_list'));
  f.handlers.get('session_start')({}, f.ctx);
  assert.deepEqual(f.api.getActiveTools(), expected);
  f.handlers.get('session_start')({}, f.ctx);
  assert.deepEqual(f.api.getActiveTools(), expected);
});
