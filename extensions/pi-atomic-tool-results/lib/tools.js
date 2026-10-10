import { validateArguments } from './validate.js';
import { BATCH_SCHEMA, executeBatch } from './batch.js';
import { Scheduler } from './scheduler.js';
import { toolSignature } from './progress.js';
import { redact } from './redact.js';
// Provider function declarations stay constant. Tool schemas enter the transcript
// once, as an immutable tool_search result. Only a small FIFO of names/hashes is
// cached for context; independent discovery grants authorize tool_invoke. No deferred schemas are activated in tools[].
import { createHash } from 'node:crypto';
import { ProgressGuard, relevantDiscovery, activeNetworkRisk, containerHostCommandRisk } from './progress.js';
import { CapabilityTracker, capabilityForQuery } from './capabilities.js';

export const SCHEMA_ENTRY = 'pi.atomic-tool-schema';
export const INVOKE_NAME = 'tool_invoke';
const SEARCHABLE = new Set(['deferred', 'codemode']);
const DIRECT_RESULTS = new Set(['result_get', 'result_list']);
const FIXED_PROVIDER_TOOLS = new Set(['read','bash','edit','write','tool_search','tool_invoke','result_get','result_list']);
const LOCAL_RESULTS = new Set(['result_get', 'result_search', 'result_list']);
export function isControlOnlyReply(content) {
  const text=(content??[]).filter(c=>c.type==='text').map(c=>c.text??'').join(' ').trim();
  return Boolean(text) && /^(?:<\/?(?:request|response|analysis|final|tool_call)>|<\|(?:im_end|eot_id|endoftext)\|>|\s)+$/i.test(text);
}

export const SEARCH_DESCRIPTION = 'Discover one specific deferred MCP operation using server + verb + object (e.g. system docker list containers). If useful call tool_invoke; otherwise refine. Do not inventory schemas. result_get and result_list are permanent direct tools; do not discover them.';
export const INVOKE_SCHEMA = {
  type: 'object',
  properties: {
    refresh: { type: 'boolean', description: 'Bypass recent read-result reuse when fresh observations are necessary.' },
    name: { type: 'string', description: 'Exact previously discovered operation name; schema eviction does not revoke access. Direct result_get/result_list require no lease; prefer calling them by their own names.' },
    arguments: { type: 'object', description: 'Concrete input values matching the discovered parameters. Omit only for an operation accepting an empty object; default {}.', additionalProperties: true },
  },
  required: ['name'],
  additionalProperties: false,
};

function toolHash(tool) {
  return createHash('sha256').update(JSON.stringify([tool.description, tool.parameters])).digest('hex').slice(0, 20);
}
function currentLease(branch, registry, capacity) {
  let snapshot;
  for (const entry of branch ?? []) {
    if (entry.type === 'custom' && entry.customType === SCHEMA_ENTRY && [1, 2].includes(entry.data?.version)) snapshot = entry.data;
  }
  if (!snapshot) return [];
  const source = snapshot.version === 2 ? snapshot.queue : (snapshot.tools ?? []).map(t => ({ name: t.name }));
  return (Array.isArray(source) ? source : []).flatMap(item => {
    const t = registry.get(item.name);
    if (!t || DIRECT_RESULTS.has(item.name) || !SEARCHABLE.has(t.exposure)) return [];
    const hash = toolHash(t);
    return item.hash && item.hash !== hash ? [] : [{ name: item.name, hash }];
  }).slice(-capacity);
}

export function createStableTools(pi, config, evidenceLedger = null) {
  if (!config.enabled || !config.stableTools) return undefined;
  for (const name of ['getAllTools', 'getActiveTools', 'setActiveTools']) {
    if (typeof pi[name] !== 'function') throw new Error(`Stable tool mode requires Pi 1.0 ExtensionAPI.${name}()`);
  }
  const scheduler = new Scheduler({ concurrency: config.queueConcurrency, deadlineMs: config.queueDeadlineMs });
  let grants = new Map();
  const diagnosticUncapped = config.diagnosticUncapped === true;
  // Diagnostic: no artificial FIFO eviction or schema-count clamp. Registered
  // tool identity, schema hashes, and nested Pi permissions remain mandatory.
  const capacity = diagnosticUncapped ? Number.MAX_SAFE_INTEGER : Math.min(9, Math.max(1, config.leaseCapacity ?? 9));
  const searchGuard = diagnosticUncapped ? (config.discoveryGuard ?? 40) : capacity;
  const skipLimit = config.discoveryRefineLimit ?? 2;
  const schemaLimit = diagnosticUncapped ? Number.MAX_SAFE_INTEGER : config.maxSchemas;
  let queue = [], repairs = 0, searchesSinceInvoke = 0, visibleSchemas = null, mustInvoke = null, pendingSearch = false, pendingSearchCallId = null, pendingSearchQuery = null, pendingBatch = [], pendingSearches = new Map(), pendingSerial = 0, lastReadyQuery = '', skips = 0;
  let rejectedChoices = new Set();
  const capability = new CapabilityTracker({ maxMisses: config.capabilityMissLimit ?? 3 });
  const progress = new ProgressGuard({ maxCalls: config.maxTurnCalls, repeatLimit: config.repeatLimit,
    navigationRetryLimit: config.navigationRetryLimit, maxBlocked: config.maxBlockedAttempts ?? 10,
    maxRepeatedBlocks: config.maxRepeatedBlocks ?? 4 });
  let userAuthorization = false, hardStopRecorded = false;
  let activeRequest = null;
  let passiveOnly = false;
  const browserTargets = new Set();
  const authorizedRisk = (name, args) => {
    const tool = registry().get(name);
    const effect = tool?.parameters?.['x-pi-effect'] ?? tool?._meta?.['ai.catalog']?.effect;
    if (/browser_click|browser_type|browser_fill/.test(name) && !browserTargets.has(String(args?.ref??args?.selector??''))) return 'Browser target was not observed in a current snapshot; retrieve page state first';
    if (passiveOnly && /(?:^|_)(?:set|write|delete|remove|create|restart|stop|start|install|upgrade|action|send)(?:_|$)/.test(name) && !LOCAL_RESULTS.has(name)) return 'Task policy denies state-changing operations';
    if (passiveOnly && (effect === 'mutation' || effect === 'active_probe' || (tool?.annotations?.readOnlyHint === false && !['passive_capture','workspace_write'].includes(effect)))) return 'Task policy permits only passive observations and configuration reads';
    const risk = activeNetworkRisk(registry().get(name) ?? name, args);
    return risk && !(config.allowActiveNetworkProbes && userAuthorization) ? risk : null;
  };
  const terminateOnLimit = (event, ctx, blocked) => {
    if (!blocked?.hardStop) return blocked;
    if (hardStopRecorded) return {...blocked, terminate:true};
    hardStopRecorded = true;
    const evidence = evidenceLedger?.summary() ?? { operations: [] };
    const partialReport = evidenceLedger?.report({ capabilities: capability.summary(), reason: progress.stopReason }) ?? 'No evidence collected.';
    const detail = { reason: progress.stopReason, counters: progress.snapshot(), capabilities: capability.summary(), evidence, partialReport };
    try { pi.appendEntry('pi.atomic-partial-report', { text: partialReport, reason: progress.stopReason }); } catch {}
    try { pi.appendEntry('pi.atomic-hard-stop', detail); } catch {}
    const label = `Tool loop halted: ${progress.stopReason}. ${evidence.operations?.length ?? 0} successful unique operations. Use /atomic-report to view the deterministic evidence report; other work is NOT TESTED.`;
    try { ctx?.ui?.notify?.(label + '\n\n' + partialReport, 'warning'); } catch {}
    // Pi 1.0 ExtensionContext exposes abort in some integrations. Never
    // shutdown the Pi service; abort only this unproductive agent turn.
    try { pi.sendMessage?.({customType:'pi.atomic-partial-report',content:partialReport,display:true},{triggerTurn:false}); } catch {}
    return { ...blocked, terminate: true, reason: label };
  };
  const refuse = (event, ctx, reason) => {
    if (event.toolName === 'tool_search' && !progress.hardStopped && !capability.unavailable(event.input?.query)) capability.discovered(event.input?.query, null);
    return terminateOnLimit(event, ctx, progress.rejectEvent(event, reason));
  };
  const registry = () => new Map(pi.getAllTools().map(t => [t.name, t]));
  const evict = () => {
    const deferred = new Set(pi.getAllTools().filter(t => SEARCHABLE.has(t.exposure) && !DIRECT_RESULTS.has(t.name)).map(t => t.name));
    const active = pi.getActiveTools();
    // Keep the two direct result tools visible even when an older Web UI
    // tool selection was restored without them. This changes startup state
    // only when necessary; requests within a session keep a fixed tools[].
    const direct = pi.getAllTools().filter(t => DIRECT_RESULTS.has(t.name)).map(t => t.name);
    const fixed = config.fixedProviderTools
      ? [...FIXED_PROVIDER_TOOLS].filter(name => registry().has(name))
      : [...new Set([...active.filter(name => !deferred.has(name)), ...direct])];
    if (JSON.stringify(fixed) !== JSON.stringify(active)) pi.setActiveTools(fixed);
  };
  const available = () => {
    const registered = registry();
    return queue.filter(item => {
      const tool = registered.get(item.name);
      return tool && !DIRECT_RESULTS.has(item.name) && SEARCHABLE.has(tool.exposure) && toolHash(tool) === item.hash;
    });
  };
  // Recently successful invocations protect useful operations from eviction.
  // Persist only names + schema hashes, never the full deferred parameters.
  const promoteSuccessfulInvocation = (name, ctx) => {
    const index = queue.findIndex(item => item.name === name);
    if (index < 0 || index === queue.length - 1) return;
    const next = [...queue.slice(0, index), ...queue.slice(index + 1), { ...queue[index], order: ++pendingSerial }];
    try {
      pi.appendEntry(SCHEMA_ENTRY, { version: 2, callId: `invoke:${name}`, queue: next });
      queue = next;
    } catch {
      // A storage failure must not report an undurable authorization update.
      // If append committed before throwing, detect that by durable queue order.
      try {
        const durable = currentLease(ctx.sessionManager.getBranch(), registry(), capacity);
        if (JSON.stringify(durable) === JSON.stringify(next.map(({ name, hash }) => ({ name, hash })))) queue = next;
      } catch {}
    }
  };
  const restore = ctx => {
    scheduler.reset();
    activeRequest = null;
    browserTargets.clear();
    grants = new Map();
    for (const entry of ctx.sessionManager.getBranch()) if (entry.customType === SCHEMA_ENTRY) {
      for (const item of entry.data?.queue ?? entry.data?.tools ?? []) if (registry().has(item.name)) grants.set(item.name,item.hash ?? toolHash(registry().get(item.name)));
    }
    queue = currentLease(ctx.sessionManager.getBranch(), registry(), capacity).map((item, i) => ({ ...item, order: i + 1 }));
    pendingSerial = Math.max(pendingSerial, queue.length);
    repairs = 0;
    searchesSinceInvoke = 0;
    mustInvoke = null; pendingSearch = false; pendingSearchCallId = null; pendingSearchQuery = null; pendingBatch = []; pendingSearches.clear(); lastReadyQuery = ''; skips = 0; rejectedChoices.clear(); capability.reset();
    visibleSchemas = null;
    evict();
  };

  const invokeDefinition = {
    name: INVOKE_NAME,
    label: 'Invoke Discovered Operation',
    description: diagnosticUncapped
      ? 'One-run diagnostic: invoke any explicitly discovered, currently registered operation with schema-valid arguments. No Pi FIFO eviction in this session; normal permissions and validation still apply. Prefer invoking immediately after discovery.'
      : 'Execute one previously discovered operation using its exact name and concrete schema-valid arguments. Execute immediately after tool_search. Previously discovered operations stay invocable; the schema cache is independent of execution. Uses the target\'s normal Pi permissions and validation. Do not invoke a JSON Schema or imitate a function call in text.',
    promptSnippet: 'Pi bash is container-local, not the Arch/Docker host. For host, network and router inventory use deferred MCP via tool_search then tool_invoke. result_get and result_list are direct, never FIFO-leased. Previously discovered MCP tools remain callable after schema-cache eviction.',
    exposure: 'model-only',
    parameters: INVOKE_SCHEMA,
    prepareLoadout(loadout = {declared:[]}) { return { ...(config.fixedProviderTools ? {hiddenDeclarations:loadout.declared.filter(tool=>!FIXED_PROVIDER_TOOLS.has(tool.name)).map(tool=>tool.name)} : {}), descriptions: { bash: 'Pi container-local workspace shell only. Do not use for host OS, RAM, Docker, Ollama, OpenWrt, physical NIC, routes or LAN diagnostics; discover system/security MCP. Safe workspace commands remain available.', tool_invoke: 'Execute an exact previously discovered deferred MCP operation; schema-cache eviction does not revoke discovery grants. Use concrete validated arguments. Direct result_get/result_list need no lease.', tool_search: diagnosticUncapped
      ? 'Diagnostic only: discover matching operations with no Pi-enforced count or FIFO lease cap. Native tool_search validation still applies. Invoke exact names promptly with concrete arguments. Provider tool declarations remain fixed.'
      : SEARCH_DESCRIPTION, result_get: 'Permanent direct archive read by result_ref and selector. No discovery, tool_invoke wrapper or FIFO authorization needed.', result_list: 'Permanent direct listing of recent archived result references. No discovery or FIFO authorization; use result_get for exact evidence.' } }; },
    async execute(_id, params, signal, onUpdate, ctx) {
      if (params.arguments === undefined) params = {...params,arguments:{}};
      // result_get/result_list are permanent direct tools, not leased MCP operations.
      // Some smaller models mistakenly call them through tool_invoke. Route the
      // call through the registered tool to preserve Pi's validation/permissions.
      const isDirect = DIRECT_RESULTS.has(params.name) && registry().has(params.name);
      const risk = authorizedRisk(params.name, params.arguments);
      if (risk) throw new Error(risk);
      if (!isDirect && (!registry().has(params.name) || grants.get(params.name) !== toolHash(registry().get(params.name)))) {
        throw new Error(diagnosticUncapped ? 'Tool is not discovered/registered in this diagnostic process (or its schema changed). Rediscover it.' : 'Operation is undiscovered or its schema changed. Discover the exact name to obtain current arguments.');
      }
      if (typeof ctx.executeTool !== 'function') throw new Error('Pi nested tool execution is required.');
      const tool = registry().get(params.name), version = toolHash(tool);
      const cacheable = tool.annotations?.readOnlyHint === true && tool.annotations?.idempotentHint === true && !LOCAL_RESULTS.has(params.name);
      const run = async () => {
        if (toolHash(registry().get(params.name) ?? {}) !== version) throw new Error('Queued operation schema changed; rediscover before retrying');
        const raw = await ctx.executeTool(params.name, params.arguments, {signal,onUpdate});
        return {...raw,result:redact(raw.result)};
      };
      // A batch must not hold a worker while waiting for its child jobs.
      const outcome = params.name === 'tool_batch' ? await run() : await scheduler.submit(
        `${version}:${toolSignature(params.name,params.arguments)}`, run,
        {cacheable,coalesce:cacheable || tool.parameters?.['x-pi-effect']==='passive_capture',refresh:params.refresh===true,signal});
      if (/browser_navigate/.test(params.name)) browserTargets.clear();
      if (/browser_snapshot/.test(params.name)) {const text=JSON.stringify(outcome.result.content);for(const m of text.matchAll(/ref[=:]\s*([a-zA-Z0-9_-]+)/g))browserTargets.add(m[1]);}
      const outcomeStatus = progress.invocationCompleted(params.name, params.arguments, { ...outcome.result, isError: outcome.isError });
      evidenceLedger?.record(params.name, params.arguments, { ...outcome.result, isError: outcome.isError }, outcome.toolCall?.id);
      if (outcomeStatus.isError) capability.failedExecution(params.name, params.arguments);
      else {
        capability.executed(params.name, true);
        if (!isDirect) promoteSuccessfulInvocation(params.name, ctx);
      }
      // A valid older FIFO operation is real execution progress; a newer
      // discovery must not deadlock it. Direct results do not consume FIFO.
      if (!isDirect) mustInvoke = null;
      if (outcomeStatus.novel) { searchesSinceInvoke = 0; skips = 0; rejectedChoices.clear(); }
      return {
        ...outcome.result,
        details: {
          ...(outcome.result.details && typeof outcome.result.details === 'object' ? outcome.result.details : {}),
          atomicInvocation: {
            tool: params.name,
            ref: `result:${outcome.toolCall.id}`,
            isError: Boolean(outcome.isError),
            reused: outcome.cacheReused === true,
            internal: LOCAL_RESULTS.has(params.name),
          },
        },
      };
    },
  };
  pi.registerTool(invokeDefinition);
  pi.registerTool({name:'tool_batch',label:'Batch discovered operations',exposure:'deferred',description:'Execute up to 16 previously discovered operations with dependency IDs and bounded selected result fields. Queues excess work; waits once, no polling. Select paths such as json.hostname or structured.containers.',parameters:BATCH_SCHEMA,
    async execute(id,params,signal,onUpdate,ctx){
      // Preflight the complete batch before any side effects.
      for(const call of params.calls){const tool=registry().get(call.name);if(!tool || (!DIRECT_RESULTS.has(call.name)&&grants.get(call.name)!==toolHash(tool)))throw new Error('Undiscovered or changed batch operation: '+call.name);validateArguments(tool.parameters,call.arguments);const risk=authorizedRisk(call.name,call.arguments);if(risk)throw new Error(risk);}
      const results=await executeBatch(params.calls,call=>invokeDefinition.execute(id+':'+call.id,{name:call.name,arguments:call.arguments},signal,onUpdate,ctx), {maxChars:config.maxBatchChars??12000});
      return {content:[{type:'text',text:JSON.stringify({results})}],isError:results.some(r=>r.status!=='ok')};
    }
  });

  pi.on('before_agent_start', event => {
    const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
    activeRequest = {role:'user',content:[{type:'text',text:prompt},...(event?.images ?? [])],timestamp:Date.now()};
    scheduler.reset();
    // An operator flag alone cannot authorize network probes. A positive,
    // explicit user request in THIS turn is required; passive-only wins.
    const passive = /(?:passive[- ]only|read[- ]only|non[- ]invasive|without scanning|do not scan|no active scanning)/i.test(prompt);
    browserTargets.clear();
    passiveOnly = passive;
    userAuthorization = !passive && /(?:i (?:explicitly )?authoriz(?:e|ing)|you (?:are|have) (?:explicit )?permission|please (?:run|perform|conduct) (?:an? )?(?:active|arp|port|ping) (?:network )?(?:scan|sweep|probe)|actively scan)/i.test(prompt);
    evidenceLedger?.reset(); evidenceLedger?.setScope(prompt); capability.reset();
    hardStopRecorded = false;
    repairs = 0; searchesSinceInvoke = 0; mustInvoke = null; pendingSearch = false; pendingSearchCallId = null; pendingSearchQuery = null; pendingBatch = []; pendingSearches.clear(); lastReadyQuery = ''; skips = 0; rejectedChoices.clear(); progress.reset(); evict(); });
  pi.on('tool_call', (event, ctx) => {
    if (config.fixedProviderTools && !event.parentToolCallId && !FIXED_PROVIDER_TOOLS.has(event.toolName)) return refuse(event, ctx, 'This operation is not directly declared. Discover it and use tool_invoke with current schema-valid arguments.');
    // Even nested executeTool routes must respect operation authorization.
    // Tool-call budgets remain top-level only.
    if (event.parentToolCallId) {
      if (event.toolName !== INVOKE_NAME && event.toolName !== 'tool_batch' && String(event.parentToolCallId).includes('/')) {
        const budget = progress.beforeCall({...event,parentToolCallId:undefined});
        if (budget) return terminateOnLimit(event,ctx,budget);
      }
      const nestedRisk = authorizedRisk(event.toolName, event.input);
      return nestedRisk ? { block: true, reason: nestedRisk } : undefined;
    }
    if (event.toolName === 'tool_search') {
      const exhausted = capability.unavailable(event.input?.query);
      if (exhausted) return refuse(event, ctx, `Capability ${exhausted.id} is unavailable for this turn after ${exhausted.misses} attempts. Advance to the next independent task; do not reword this search.`);
    }
    // Bounded concurrent discovery: accept distinct independent searches rather
    // than returning errors for each extra model tool_call in the same batch.
    // Every search yields at most one deferred schema and the FIFO remains nine.
    // Discovery is independent of invocation grants. Independent searches are
    // never rejected merely because another schema or request is pending.
    // Check direct, ordinary shell calls as well as deferred invocations.
    const calledTool = event.toolName === INVOKE_NAME ? event.input?.name : event.toolName;
    const calledArgs = event.toolName === INVOKE_NAME ? event.input?.arguments : event.input;
    const risk = authorizedRisk(calledTool, calledArgs);
    if (risk) return refuse(event, ctx, risk + '. Use passive observations, or report NOT TESTED.');
    const hostBoundary = containerHostCommandRisk(calledTool, calledArgs);
    if (hostBoundary) return refuse(event, ctx, hostBoundary);
    if (event.toolName === 'tool_search' && /^(?:result[\s_-]*(?:get|list)|(?:get|list)[\s_-]+(?:archived[\s_-]+)?results?)(?:\s|$)/i.test(String(event.input?.query ?? '').trim()))
      return refuse(event, ctx, 'result_get and result_list are permanent direct tools; call directly.');
    const blocked = progress.beforeCall(event);
    if (blocked) return terminateOnLimit(event, ctx, blocked);
    // Every valid FIFO entry remains callable, even with a newer discovery
    // pending. Only reject unknown/evicted names before nested execution.
    if (event.toolName !== 'tool_search') return;
    // Independent known capabilities have their own bounded discovery budget;
    // do not deadlock the entire assessment after five unrelated misses.
    const searchOrder = ++pendingSerial;
    pendingSearches.set(event.toolCallId ?? `query-${searchOrder}`,
      {query:String(event.input?.query ?? '').trim().toLowerCase(), order:searchOrder});
    // Production: one schema per search, regardless of FIFO size. Diagnostic:
    // leave explicit counts untouched (native tool_search still validates).
    if (event.input.limit === undefined) event.input.limit = diagnosticUncapped ? (config.diagnosticDefaultSearchLimit ?? 1) : 1;
    else if (!diagnosticUncapped && Number.isInteger(event.input.limit) && event.input.limit > schemaLimit) event.input.limit = schemaLimit;
  });
  pi.on('agent_before_settle', event => {
    if (!config.repairTextCalls || repairs || event.outcome !== 'completed') return;
    if (event.context?.pendingMessages?.length) return;
    const messages = event.context.contextMessages ?? [];
    const last = messages.findLast(m => m.role === 'assistant');
    if (!last || last.stopReason !== 'stop' || last.content?.some(c => c.type === 'toolCall')) return;
    if (isControlOnlyReply(last.content) && evidenceLedger?.records.some(r=>r.category) && /assess|investigat|\btask\s+1/i.test(evidenceLedger.scope)) {
      repairs++;
      return {continue:true,entries:[{type:'custom_message',customType:'pi.atomic-empty-settlement-repair',display:false,content:'Your response contained only a control marker and no assessment. Continue the active user request using existing discovery grants and archived evidence. Do not repeat successful observations. Advance to an independent unfinished task or provide a measured partial report with explicit limitations.'}]};
    }
    const name = textualCallTarget(last.content, [...grants.keys()].filter(name => registry().has(name) && grants.get(name) === toolHash(registry().get(name))));
    if (!name) return;
    repairs++;
    return {
      continue: true,
      entries: [{
        type: 'custom_message', customType: 'pi.atomic-tool-call-repair', display: false,
        content: `Your last response was a textual tool-call imitation; nothing executed. Emit a real structured ${INVOKE_NAME} call with name ${JSON.stringify(name)} and concrete arguments from the discovered schema; do not pass JSON Schema metadata. Do not repeat an operation already completed.`,
      }],
    };
  });

  return {
    // Called after all extension-owned tools have been registered. The first
    // tool_search must never mutate the permanent tools/provider prefix.
    initializePermanentTools() { evict(); },
    userRequest() { return activeRequest; },
    canRepairSettlement(content) { return config.repairTextCalls && !repairs && isControlOnlyReply(content) && evidenceLedger?.records.some(r=>r.category) && /assess|investigat|\btask\s+1/i.test(evidenceLedger.scope); },
    restore,
    clear() { scheduler.reset(); browserTargets.clear(); grants.clear(); userAuthorization = false; hardStopRecorded = false; queue = []; repairs = 0; searchesSinceInvoke = 0; mustInvoke = null; pendingSearch = false; pendingSearchCallId = null; pendingSearchQuery = null; pendingBatch = []; pendingSearches.clear(); visibleSchemas = null; lastReadyQuery = ''; skips = 0; rejectedChoices.clear(); progress.reset(); capability.reset(); },
    metrics() { return { ...progress.snapshot(), fifoCount: available().length, registryGrants:grants.size, scheduler:scheduler.snapshot(), capabilities: capability.summary(), activeNetworkUserAuthorized: userAuthorization, evidence: evidenceLedger?.summary() }; },
    report() { return evidenceLedger?.report({ capabilities: capability.summary(), reason: progress.stopReason }); },
    observeToolResult(event) {
      if (event.parentToolCallId || ['tool_invoke','tool_search'].includes(event.toolName)) return;
      progress.invocationCompleted(event.toolName, event.input, event);
      evidenceLedger?.record(event.toolName,event.input,event,event.toolCallId);
    },
    count() { return available().length; },
    searchResult(event, ctx) {
      if (event.toolName !== 'tool_search' || event.parentToolCallId) return;
      // Release one slot for this exact search, not all parallel searches.
      const callId = event.toolCallId;
      let grantOrder = (callId && pendingSearches.get(callId)?.order) ?? null;
      if (callId && pendingSearches.has(callId)) pendingSearches.delete(callId);
      else {
        const matched = [...pendingSearches].find(([,v])=>v.query === String(event.input?.query ?? '').trim().toLowerCase());
        if (matched) { grantOrder = matched[1].order; pendingSearches.delete(matched[0]); }
      }
      evict();
      const registered = registry();
      const loaded = Array.isArray(event.details?.loaded) ? event.details.loaded : [];
      const rejected = [], directMatches = [];
      const native = [...new Set(loaded)];
      for (const name of native) if (DIRECT_RESULTS.has(name)) directMatches.push(name);
      const findCandidates = query => [...registered.values()].filter(t => SEARCHABLE.has(t.exposure) && !DIRECT_RESULTS.has(t.name) && !rejectedChoices.has(t.name))
        .map(t => ({ tool: t, fit: relevantDiscovery(query, t) }))
        .filter(({tool, fit}) => fit.ok && !authorizedRisk(tool.name, {}))
        .sort((a,b) => b.fit.score - a.fit.score || a.tool.name.localeCompare(b.tool.name));
      const directIntent = /^(?:result[\s_-]*(?:get|list)|(?:get|list)[\s_-]+(?:archived[\s_-]+)?results?)(?:\s|$)/i.test(String(event.input?.query ?? '').trim());
      if (directIntent && !directMatches.length) directMatches.push('result_get', 'result_list');
      let candidates = directIntent ? [] : findCandidates(event.input?.query), matchedQuery = event.input?.query;
      // Each concurrent search is resolved independently and grants one schema.
      const coalesced = 0;
      // Pi's native fuzzy discovery is useful for ranking; where it supplies an
      // unrelated match, prefer a strictly better exact-action catalog match.
      // No extra provider tool declaration is added; FIFO still authorizes one.
      for (const name of native) {
        const t = registered.get(name);
        if (!t || DIRECT_RESULTS.has(name)) continue;
        const fit = relevantDiscovery(event.input?.query, t);
        if (!fit.ok || rejectedChoices.has(name) || authorizedRisk(t.name, {}))
          rejected.push({ name, reason: fit.ok ? 'Rejected or active-only match' : fit.reason });
      }
      // Native fuzzy search may report no match even when a registered Pi-owned
      // deferred capability satisfies the exact intent. Validate the registry
      // match independently before yielding a failed native discovery.
      const best = directIntent || capability.unavailable(event.input?.query) ? null : candidates[0] ?? null;
      const capabilityState = capability.discovered(event.input?.query, best?.tool.name ?? null);
      const selected = best ? [{ name: best.tool.name, description: best.tool.description, parameters: best.tool.parameters, hash: toolHash(best.tool) }] : [];
      progress.searchCompleted(event.input?.query, { rejected: (rejected.length > 0 || directMatches.length > 0) && !selected.length });
      // Empty, unsafe or failed discovery must not invalidate existing leases.
      if (!selected.length) {
        const marker = { discovery: capabilityState?.state === 'unavailable' ? 'unavailable' : directMatches.length ? 'direct' : rejected.length ? 'irrelevant' : event.isError ? 'failed' : 'empty', ...(capabilityState ? { capability: capabilityState.id, attempts: capabilityState.misses } : {}), ...(rejected.length ? { rejected } : {}), ...(directMatches.length ? { direct: directMatches } : {}), buffered: available().map(t => t.name), ...(coalesced ? { coalescedSearches: coalesced } : {}), next: directMatches.length ? 'Call the named direct result_get/result_list tool now. No tool_invoke, discovery, or FIFO lease is needed.' : capabilityState?.state === 'unavailable' ? 'Capability exhausted for this turn. Advance to another task and label this one NOT TESTED; do not retry synonyms.' : 'Use a narrower server + verb + object query, or report unavailable. Do not invoke a rejected operation.', ...(event.isError ? { error: event.content } : {}) };
        return { content: [{ type: 'text', text: JSON.stringify(marker) }], details: { atomicSchema: true, schemaCallId: event.toolCallId, loaded: [] }, isError: Boolean(event.isError) };
      }
      grantOrder ??= ++pendingSerial;
      const before = [...queue];
      const newly = [], reused = [];
      for (const item of selected) {
        const existing = queue.find(entry => entry.name === item.name);
        if (existing?.hash === item.hash && (visibleSchemas === null || visibleSchemas.get(item.name) === item.hash)) reused.push(item.name);
        else newly.push(item);
        // Refreshing a tool makes it most recently discovered; no duplicate grants.
        queue = queue.filter(entry => entry.name !== item.name);
        queue.push({ name: item.name, hash: item.hash, order: grantOrder });
      }
      // Stable grant order is tool-call order even when parallel results finish
      // out of order. The newest nine discoveries win, not the last responders.
      queue.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
      queue = queue.slice(-capacity);
      const evicted = before.filter(item => !queue.some(t => t.name === item.name)).map(item => item.name);
      const snapshot = { version: 2, callId: event.toolCallId, queue: [...queue] };
      try { pi.appendEntry(SCHEMA_ENTRY, snapshot); }
      catch {
        const durable = currentLease(ctx.sessionManager.getBranch(), registered, capacity);
        // If append failed before committing, leave grants at last durable state.
        if (JSON.stringify(durable.map(({name,hash})=>({name,hash}))) !== JSON.stringify(queue.map(({name,hash})=>({name,hash})))) {
          queue = before;
          return { content: [{ type: 'text', text: 'Discovery state could not be saved. New tool is not authorized; retry after fixing session persistence.' }], details: { atomicSchema: true }, isError: true };
        }
      }
      for (const item of selected) grants.set(item.name,item.hash ?? toolHash(registry().get(item.name)));
      searchesSinceInvoke++;
      mustInvoke = new Set(selected.map(t => t.name));
      lastReadyQuery = String(event.input?.query ?? '').trim().toLowerCase();
      const marker = {
        discovery: newly.length ? 'ready' : 'reused',
        ...(capabilityState ? { capability: capabilityState.id } : {}),
        tools: newly.map(({ name, description, parameters }) => ({ name, description, parameters })),
        ...(reused.length ? { reused } : {}),
        buffered: queue.map(t => t.name),
        ...(evicted.length ? { evicted } : {}),
        ...(coalesced ? { coalescedSearches: coalesced, matchedQuery } : {}),
        execution: INVOKE_NAME,
        next: 'Invoke this exact operation with concrete arguments if applicable. If the match is unsuitable, refine tool_search with a different, more specific action; never invoke an irrelevant or unsafe tool.',
      };
      // Full schema appears once in the immutable search response. NEVER rewrite
      // any earlier toolResult on later turns (preserves Ollama KV-cache prefix).
      return { content: [{ type: 'text', text: JSON.stringify(marker) }], details: { atomicSchema: true, schemaCallId: event.toolCallId, loaded: selected.map(t => t.name) }, isError: false };
    },
    context(messages) {
      // Read-only visibility scan. After compaction, an old authorization may
      // survive in the branch while its argument schema is no longer visible to
      // the model. The next rediscovery then emits it again as a *new suffix*,
      // never by rewriting an earlier provider message.
      const seen = new Map();
      const registered = registry();
      for (const m of messages) {
        if (m.role !== 'toolResult' || m.toolName !== 'tool_search' || !m.details?.atomicSchema) continue;
        try {
          const marker = JSON.parse(m.content?.find(c => c.type === 'text')?.text ?? '{}');
          for (const tool of marker.tools ?? []) if (tool.name && tool.parameters) {
            const match = registered.get(tool.name);
            if (match && JSON.stringify(tool.parameters) === JSON.stringify(match.parameters)) seen.set(tool.name, toolHash(match));
          }
        } catch {}
      }
      const budget = config.schemaCharBudget ?? 16384;
      let used = 0;
      const bounded = [...messages];
      for (let i=bounded.length-1;i>=0;i--) {
        const m=bounded[i];if(!m.details?.atomicSchema)continue;
        const chars=JSON.stringify(m.content).length;
        if(used+chars<=budget){used+=chars;continue;}
        const names=m.details.loaded??[];
        names.forEach(name=>seen.delete(name));
        bounded[i]={...m,content:[{type:'text',text:JSON.stringify({discovery:'schema_out_of_context',names,next:chars>budget?'Schema exceeds the context budget. Do not rediscover repeatedly; ask for narrower schema guidance or increase the configured schema budget.':'Previously discovered operations remain invocable. Rediscover exact name only if argument schema is needed.'})}]};
      }
      visibleSchemas = seen;
      return bounded;
    },
  };
}

// Recognition only. Never parse arguments or turn assistant text into execution.
export function textualCallTarget(content, names) {
  const text = (content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  if (!text || text.startsWith('```') || text.startsWith('>')) return;
  for (const name of names) {
    if (text.startsWith(`call:${name}{`) || text.startsWith(`call:${name} {`)) return name;
    if (text.startsWith('<tool_call>') && text.includes(name) && /[\{"(]/.test(text.slice(11))) return name;
    if ((text.startsWith(`call:${INVOKE_NAME}{`) || text.startsWith(`call:${INVOKE_NAME} {`)) && text.includes(name)) return name;
  }
}
