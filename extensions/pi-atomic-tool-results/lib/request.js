import { createHash } from 'node:crypto';
import { redact } from './redact.js';

// Idempotent request repair: retain the actual request and complete tool pairs.
export function prepareMessages(messages, activeUser) {
  let out = [...messages];
  const text = m => typeof m?.content === 'string' ? m.content : (m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  if (activeUser && !out.some(m => m.role === 'user' && text(m) === text(activeUser))) out.unshift(activeUser);
  const results = new Set(out.filter(m=>m.role==='toolResult').map(m=>m.toolCallId));
  const calls = new Set();
  out = out.map(m => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.filter(b=>b.type!=='toolCall' || results.has(b.id));
    content.filter(b=>b.type==='toolCall').forEach(b=>calls.add(b.id));
    return content.length === m.content.length ? m : {...m,content};
  }).filter(m => m.role !== 'toolResult' || calls.has(m.toolCallId));
  return out.map(m=>m.role === 'toolResult' && !m.details?.atomicSchema ? {...m,content:redact(m.content),details:redact(m.details)} : m);
}
export function requestManifest(messages) {
  return {version:1, userPresent:messages.some(m=>m.role==='user'), messages:messages.map(m=>({role:m.role,tool:m.toolName,callId:m.toolCallId,ref:m.details?.atomicSourceRef??m.details?.resultRef,selector:m.details?.selector,bytes:Buffer.byteLength(JSON.stringify(m.content??[])),digest:createHash('sha256').update(JSON.stringify(m.content??[])).digest('hex').slice(0,16)}))};
}

// Check the final chat-completions payload after Pi's adapter conversion.
export function prepareProviderPayload(payload, activeUser) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  let messages = [...payload.messages];
  if (!messages.some(m => m.role === 'user')) {
    if (!activeUser) throw new Error('Provider request has no active user query; refusing an invalid request');
    messages.unshift({ role: 'user', content: activeUser.content });
  }
  const resultIds = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  const callIds = new Set();
  messages = messages.map(m => {
    if (m.role !== 'assistant' || !m.tool_calls) return m;
    const tool_calls = m.tool_calls.filter(call => resultIds.has(call.id));
    tool_calls.forEach(call => callIds.add(call.id));
    if (tool_calls.length === m.tool_calls.length) return m;
    const next = { ...m };
    if (tool_calls.length) next.tool_calls = tool_calls;
    else { delete next.tool_calls; next.content ??= ''; }
    return next;
  }).filter(m => m.role !== 'tool' || callIds.has(m.tool_call_id));
  messages = messages.map(m => {
    if(m.role!=='tool')return m;
    try {const data=JSON.parse(m.content);if(data.discovery && data.tools?.some(t=>t.parameters))return m;} catch {}
    return {...m,content:redact(m.content)};
  });
  return { ...payload, messages };
}

export function providerManifest(payload) {
  return {
    version: 1, model: payload?.model,
    bytes: Buffer.byteLength(JSON.stringify(payload ?? {})),
    schemaVersions: (payload?.tools ?? []).map(t => ({name:t.function?.name ?? t.name,digest:createHash('sha256').update(JSON.stringify(t)).digest('hex').slice(0,16)})),
    messages: (payload?.messages ?? []).map(m => ({role:m.role,callId:m.tool_call_id,bytes:Buffer.byteLength(JSON.stringify(m.content ?? '')),digest:createHash('sha256').update(JSON.stringify(m.content ?? '')).digest('hex').slice(0,16)})),
    userPresent: (payload?.messages ?? []).some(m => m.role === 'user'),
  };
}
