import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJsonl } from '../scripts/analyze-agent-loop.mjs';
const msg = (role, value = {}) => JSON.stringify({ type:'message', message:{role,...value} });
test('benchmark reports repeated calls, cache reuse, cold prefill, and compaction',()=>{
  const calls = [{type:'toolCall',id:'a',name:'tool_search',arguments:{query:'ollama models'}},{type:'toolCall',id:'b',name:'tool_invoke',arguments:{name:'list_mcp_resources',arguments:{}}}];
  const trace = [msg('assistant',{content:calls,usage:{input:500,cacheRead:2000,output:100}}),msg('toolResult',{toolCallId:'b',toolName:'tool_invoke',content:[{type:'text',text:'same'}]}),
    msg('assistant',{content:[{...calls[1],id:'c'}],usage:{input:300,cacheRead:0,output:40}}),msg('toolResult',{toolCallId:'c',toolName:'tool_invoke',content:[{type:'text',text:'same'}]}),
    JSON.stringify({type:'compaction',tokensBefore:24642})].join('\n');
  const r=analyzeJsonl(trace);
  assert.equal(r.compactions,1); assert.equal(r.coldRequests,1); assert.equal(r.invocations,2); assert.equal(r.repeatedResults,1);
  assert.equal(r.cacheReadShare, Number((2000/2800).toFixed(5)));
  assert.equal(r.duplicateInvocations,1);
});
