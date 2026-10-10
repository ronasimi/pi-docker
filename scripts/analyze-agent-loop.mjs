#!/usr/bin/env node
// Read-only Pi JSONL benchmark: call volume, repeated outcomes, cache reuse,
// compaction and cold-prefix events. No dependency on the live server or SDK.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const isToolCall = x => x?.type === 'toolCall';
export function analyzeJsonl(source) {
  const entries = source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const calls = new Map(), usage = { input:0, output:0, cacheRead:0, cacheWrite:0 }, counts = {}, resultSeen = new Map();
  let compactions = 0, coldRequests = 0, modelRequests = 0, repeatedResults = 0, duplicateInvocations = 0;
  let repeatedSearches = 0, searches = 0, invocations = 0, directGets = 0, directLists = 0, totalToolCalls = 0;
  const signatureSeen = new Map(), compactionTokens = [], topResults = new Map();
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      compactions++;
      compactionTokens.push(entry.tokensBefore ?? entry.tokenCount ?? entry.firstKeptEntryTokens ?? null);
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message ?? {};
    if (message.role === 'assistant') {
      const u = message.usage;
      if (u) {
        modelRequests++;
        for (const key of Object.keys(usage)) usage[key] += Number(u[key] ?? 0);
        if (!(u.cacheRead > 0)) coldRequests++;
      }
      for (const call of message.content ?? []) if (isToolCall(call)) {
        const args = call.arguments ?? {};
        calls.set(call.id, { name:call.name, args });
        counts[call.name] = (counts[call.name] ?? 0) + 1;
        totalToolCalls++;
        const sig = `${call.name}:${hash(args)}`;
        const already = signatureSeen.get(sig) ?? 0;
        if (already > 0 && call.name === 'tool_invoke') duplicateInvocations++;
        if (already > 0 && call.name === 'tool_search') repeatedSearches++;
        signatureSeen.set(sig, already + 1);
        if (call.name === 'tool_search') searches++;
        if (call.name === 'tool_invoke') invocations++;
        if (call.name === 'result_get') directGets++;
        if (call.name === 'result_list') directLists++;
      }
    }
    if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      const name = call?.name ?? message.toolName;
      if (name === 'tool_search') continue;
      const args = call?.args ?? {};
      const target = name === 'tool_invoke' ? args.name : name;
      if (!target) continue;
      const key = `${target}:${hash(name === 'tool_invoke' ? args.arguments : args)}`;
      const fingerprint = hash((message.content ?? []).map(x => x?.type === 'text'
        ? String(x.text ?? '').replace(/result:[a-z0-9_\/-]+/ig,'result:REF')
        : x?.type));
      const last = resultSeen.get(key);
      if (last === fingerprint) repeatedResults++;
      resultSeen.set(key, fingerprint);
      topResults.set(target, (topResults.get(target) ?? 0) + 1);
    }
  }
  const totalInput = usage.cacheRead + usage.input;
  return { totalToolCalls, toolCounts:counts, searches, invocations, directGets, directLists,
    duplicateInvocations, repeatedSearches, repeatedResults,
    compactions, compactionTokens,
    modelRequests, coldRequests, usage,
    cacheReadShare:totalInput ? Number((usage.cacheRead / totalInput).toFixed(5)) : null,
    frequentOperations:[...topResults].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count])=>({name,count})) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) { console.error('Usage: node scripts/analyze-agent-loop.mjs session.jsonl'); process.exit(2); }
  try { console.log(JSON.stringify(analyzeJsonl(readFileSync(path,'utf8')),null,2)); }
  catch (e) { console.error(e.message); process.exit(1); }
}
