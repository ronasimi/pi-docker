import { redact } from './redact.js';
import { classifyOutcome } from './outcome.js';
import { toolSignature } from './progress.js';
// Conservative, deterministic evidence accounting for infrastructure reports.
// A successful tool invocation proves only that its operation ran and supplied
// evidence, not every factual inference the model may draw from it.
const LOW_INFORMATION = /^(?:\s*|\{\s*\}|\[\s*\]|null|undefined|no results? found|no data|unavailable|not found|permission denied|error:.*)$/i;
const isToolEvidence = (name, result) => {
  if (!name || ['tool_search', 'result_get', 'result_list', 'result_search', 'tool_invoke', 'tool_batch'].includes(name)) return false;
  if (!classifyOutcome(result).usable) return false;
  const body = (result?.content ?? []).filter(x => x.type === 'text').map(x => String(x.text ?? '')).join(' ').trim();
  if ((!body || LOW_INFORMATION.test(body)) && !result?.structuredContent) return false;
  if (/"(?:status|success)"\s*:\s*"?(?:error|failed|unavailable|not_found)\b/i.test(body)) return false;
  return true;
};
const serverOp = name => String(name ?? '').toLowerCase().replace(/^mcp__[a-z0-9]+__/, '');
const dataFromResult = result => {
  const body = (result?.content ?? []).filter(x=>x?.type === 'text').map(x=>String(x.text ?? '')).join(' ');
  if (result.structuredContent) return redact(result.structuredContent);
  try { return redact(JSON.parse(body)); } catch { return null; }
};
function operationScope(name, data) {
  const declared = String(data?.scope ?? '').toLowerCase();
  if (declared.includes('container')) return 'container';
  if (declared.includes('host') || declared === 'physical_host') return 'host';
  if (/^mcp__security__/.test(name)) return 'security-container-or-observed-network';
  if (/^mcp__system__host_/.test(name)) return 'host';
  if (/^mcp__system__docker_/.test(name)) return 'docker-daemon';
  if (/^ollama_api_/.test(name)) return 'ollama-api';
  return 'operation-specified';
}
export function evidenceCategory(name) {
  const op = serverOp(name);
  if (/openwrt/.test(op)) return 'routers';
  if (/ollama.*(?:list_models|models_list|show_models|model_inventory|api_inventory)/.test(op)) return 'ollama_models';
  if (/docker_(?:list_containers|list_images|container_stats)/.test(op)) return 'docker';
  if (/host_(?:snapshot|cpu_info)|system_info/.test(op)) return 'host';
  if (/network_interfaces|host_interface|get_host_interface|network_route/.test(op)) return 'interfaces';
  if (/(?:mdns|ssdp|llmnr|packet_capture|passive|multicast)/.test(op)) return 'passive_network';
  if (/(?:isolation|reflector|hairpin|proxy_arp)/.test(op)) return 'isolation';
  if (/(?:topology|subnet|network_discovery)/.test(op)) return 'topology';
  if (/(?:mcp_endpoint_health|mcp_health|mcp_server_status|mcp_connection_status)/.test(op)) return 'mcp_health';
  if (/(?:searxng.*search|web_search|browser_navigate|browser_snapshot)/.test(op)) return 'web_verification';
  return null;
}
// This ledger deliberately stores only bounded, non-secret provenance metadata;
// a successful call is not equivalent to proof that every reported claim is true.
const REPORT_TASKS = [
  ['Host and container inventory', ['host','docker','ollama_models']],
  ['OpenWrt router discovery', ['routers:anansi','routers:arachne']],
  ['Network and mDNS discovery', ['passive_network','topology']],
  ['Network isolation assessment', ['isolation']],
  ['MCP infrastructure health', ['mcp_health']],
  ['Independent web verification', ['official_source']],
  ['Cross-tool reasoning', ['manual_review']],
  ['Evidence and context retention', ['manual_review']],
];
function requirement(ledger, name) {
  if (name === 'routers:anansi') return ledger.routerCoverage().anansi;
  if (name === 'routers:arachne') return ledger.routerCoverage().arachne;
  if (name === 'manual_review') return false; // not defensibly proven by an operation name
  return ledger.has(name);
}
export class EvidenceLedger {
  constructor() { this.reset(); }
  reset() { this.records = []; this.ids = new Set(); this.scope = ''; this.officialNavigation = null; this.requirements = new Map(); }
  setScope(prompt) { this.scope = String(redact(prompt ?? '')); }
  record(name, args, result, id) {
    if (!isToolEvidence(name, result)) return false;
    const key = id ? `${id}` : toolSignature(name, args ?? {});
    if (this.ids.has(key)) return false;
    this.ids.add(key);
    const target = JSON.stringify(redact(args ?? {})).slice(0, 160);
    const data = dataFromResult(result);
    const body = (result?.content ?? []).filter(x=>x?.type === 'text').map(x=>String(x.text ?? '')).join(' ');
    let category = evidenceCategory(name);
    const scope = operationScope(name, data);
    if (category === 'mcp_health' && name === 'mcp_endpoint_health' &&
        !(data?.checked > 0 && data.verified === data.checked && data.endpoints?.every(x=>x.state === 'handshake_ok')))
      category = 'mcp_health_partial';
    if (category === 'mcp_health') category = 'mcp_handshake';
    const official = url => {
      try { const u = new URL(String(url)); return u.protocol === 'https:' && (u.hostname === 'openwrt.org' || u.hostname.endsWith('.openwrt.org')); }
      catch { return false; }
    };
    if (category === 'web_verification') {
      if (/browser_navigate/.test(name) && official(args?.url ?? args?.target))
        this.officialNavigation = String(args?.url ?? args?.target);
      if (/browser_snapshot/.test(name) && this.officialNavigation &&
          body.length >= 120 && /https?:\/\/(?:[-a-z0-9]+\.)?openwrt\.org\b/i.test(body))
        category = 'official_source';
    }
    const facts = extractFacts(data);
    const routerState = /openwrt_(?:router_)?status$/.test(name) && data?.board != null && Array.isArray(data?.interfaces) && data?.evidence_available !== false;
    this.records.push({ name, category, scope, target, facts, routerState, stage:'collected', domainOutcome:data?.status??'observed', complete:data?.complete===true, timestamp:Date.now(),
      ref: typeof id === 'string' ? id : null });
    if (this.records.length > 100) this.records.shift();
    return true;
  }
  defineRequirement(id, selectors) { this.requirements.set(id,{id,selectors,stage:'pending',evidence:[]}); }
  inspect(ref, selectors) {
    const record=this.records.find(r=>r.ref===ref || `result:${r.ref}`===ref); if(!record)return false;
    record.stage='inspected';
    for(const requirement of this.requirements.values()){
      const paths=selectors.map(s=>s.replace(/^(?:json|structured|structuredContent)\.?/,''));
      const facts=record.facts.filter(f=>paths.some(p=>p==='' || p===f.path || f.path.startsWith(p+'.')));
      if(!facts.length)continue;
      requirement.evidence.push(...facts.map(f=>({...f,ref:record.ref})));
      requirement.stage=requirement.selectors.every(path=>requirement.evidence.some(f=>f.path===path))?'sufficient':'inspected';
    }return true;
  }
  checkpoint() {return redact({version:1,scope:this.scope,records:this.records,requirements:[...this.requirements]});}
  restore(data) {if(data?.version!==1)return;this.scope=String(redact(data.scope??''));this.records=redact(Array.isArray(data.records)?data.records:[]).map(r=>({...r,facts:Array.isArray(r.facts)?r.facts:[]})).slice(-100);this.ids=new Set(this.records.map(r=>r.ref));this.requirements=new Map(Array.isArray(data.requirements)?redact(data.requirements):[]);}
  promptSummary() {const value={observations:this.records.slice(-12).map(r=>({ref:`result:${r.ref}`,scope:r.scope,facts:r.facts.slice(0,8),stage:r.stage})),requirements:[...this.requirements.values()]};while(JSON.stringify(value).length>10000&&value.observations.length)value.observations.shift();return JSON.stringify(value);}
  counts() { return Object.fromEntries([...new Set(this.records.map(x=>x.category).filter(Boolean))].map(cat=>[cat,this.records.filter(x=>x.category===cat).length])); }
  has(category) { return this.records.some(r => r.category === category); }
  routerCoverage() {
    // Alias discovery and historical logs never verify current router state.
    const rows = this.records.filter(r => r.category === 'routers' && r.routerState === true);
    return { anansi: rows.some(r => /anansi/i.test(r.target)), arachne: rows.some(r => /arachne/i.test(r.target)) };
  }
  taskCoverage() {
    const listed = [...this.scope.matchAll(/\bTASK\s+(\d+)\s*[—–:-]/gi)];
    const tasks = listed.length ? [...new Set(listed.map(m=>Number(m[1])))].filter(n=>n>=1 && n<=REPORT_TASKS.length) : REPORT_TASKS.map((_,i)=>i+1);
    return tasks.map(id=>{
      const [label, requirements] = REPORT_TASKS[id-1];
      const met = requirements.filter(name=>requirement(this,name));
      return { id, label, requirements, observed: met, status: met.length ? 'PARTIAL' : 'NOT TESTED' };
    });
  }
  summary() { return { operations: this.records.map(r=>({...r})), categories: this.counts(), routers: this.routerCoverage(),
    successfulToolCalls: this.records.length, distinctOperations: new Set(this.records.map(r=>r.name)).size, taskCoverage: this.taskCoverage() }; }
  report({ capabilities = {}, reason = null } = {}) {
    const summary=this.summary(), tasks=summary.taskCoverage;
    const safe=t=>String(t).replace(/\|/g,'\\|').replace(/[\r\n]/g,' ');
    const sections=[
      '## Deterministic infrastructure evidence report',
      '',
      reason ? `**Stopped:** ${safe(reason)}` : '**Status:** Partial observations; no inference is automatically confirmed',
      '',
      `**Successful executed tool calls:** ${summary.successfulToolCalls} (not counting tool_search, result_get, result_list or tool_invoke wrappers).`,
      `**Distinct executed operations:** ${summary.distinctOperations}.`,
      '**Coverage:** Categories below track collected observations only. Task sufficiency and independent verification require explicit review.',
      '',
      '| Task | Verification evidence | Status |',
      '|---|---|---|',
      ...tasks.map(t=>`| ${t.id}. ${safe(t.label)} | ${t.observed.length}/${t.requirements.length} required evidence categories | ${t.status} |`),
      '',
      '**Observed values (source fields; no inferred topology or isolation):**',
      ...summary.operations.flatMap(r=>r.facts.map(f=>`- ${safe(r.name)}: ${safe(f.path)} = ${safe(JSON.stringify(f.value))} [result:${safe(r.ref??'unknown')}]`)).slice(0,100),
      '',
      '**Successful operation references (not independent verification of every claim):**',
      ...summary.operations.slice(0,30).map(r=>`- \`${safe(r.name)}\` — ${safe(r.category ?? 'uncategorized')} [${safe(r.scope ?? 'unknown-scope')}]${r.ref ? `; call ${safe(r.ref)}` : ''}`),
      ...(!summary.operations.length ? ['- None'] : []),
      '',
      '**Bounded collected facts (observations, not inferred conclusions):**',
      ...summary.operations.filter(r=>r.facts?.length).slice(0,16).map(r=>{
        const facts=r.facts.filter(f=>!/(?:^|\.)(?:status|scope|complete|available|length|version|timestamp)$/.test(f.path)).slice(0,4);
        return `- ${safe(r.name)}${r.ref ? ` [result:${safe(r.ref)}]` : ''}: ${facts.map(f=>`${safe(f.path)}=${safe(JSON.stringify(f.value)).slice(0,260)}`).join('; ') || 'No non-metadata scalar facts retained'}`;
      }),
      '',
      '**Unavailable capability searches:**',
      ...Object.entries(capabilities).filter(([,v])=>v.state==='unavailable').map(([k,v])=>`- ${safe(k)}: ${v.misses} unsuccessful attempts; NOT TESTED`),
      ...(!Object.values(capabilities).some(v=>v.state==='unavailable') ? ['- None recorded'] : []),
      '',
      'Tool execution is not proof of topology, API health, network isolation or task completion. Container namespace addresses must not be used as physical-host routes. Missing evidence remains NOT TESTED. No completion fraction is inferred from model prose.'
    ];
    return sections.join('\n');
  }
}

const CONFIDENT = /\b(?:confirmed|verified|validated|complete|completed|passed|successful)\b/i;
// Report lines only. Ordinary discussion and code blocks remain untouched.
export function auditInfrastructureReport(text, ledger) {
  const original = String(text ?? '');
  const report = /(?:technical\s+assessment|network\s+assessment|infrastructure\s+assessment|findings\s+report|\btask\s+completion\b|\bconfirmed\s+findings\b)/i.test(original);
  if (!report || !ledger?.scope || !/(?:router|network|mcp|host|docker|ollama|infrastructure|assessment)/i.test(ledger.scope))
    return { text: original, issues: [], changed: false };
  const issues = new Set();
  let insideCode = false;
  const lines = original.split('\n').map(line => {
    if (/^\s*```/.test(line)) { insideCode = !insideCode; return line; }
    if (insideCode || /^\s*#{1,6}\s/.test(line) || !line.trim()) return line;
    const topics = [];
    const clean = line.replace(/\*\*/g, '');
    if (/^\s*(?:[-*]\s+|\d+\.\s+)?(?:retrieve|check|test|validate|inspect|investigate|recommend|follow[- ]up)\b/i.test(clean)) return line;
    const strong = CONFIDENT.test(clean) || /\b(?:operat(?:e|es|ing) (?:correctly|as intended)|functioning as expected|healthy|fully integrated)\b/i.test(line);
    const inferred = /\b(?:flat\s+(?:local\s+area\s+)?network|single\s+(?:primary|logical|flat)\s+(?:subnet|boundary)|single\s+broadcast\s+domain|multicast\s+leakage|inter[- ]subnet\s+reflection)\b/i.test(clean) ||
      (/\b(?:client\s+isolation|proxy\s+arp|hairpin|mDNS\s+reflect(?:or|ion))\b/i.test(clean) &&
       /\b(?:no\s+evidence|not\s+observed|was\s+observed|found|confirmed|verified|working|enabled|disabled)\b/i.test(clean));
    const taskCount = /(?:tasks?\s+(?:completed|passed)\s*:\s*\d+\s*\/\s*\d+|\d+\s*(?:\/|of)\s*\d+\s*(?:tasks?|checks?|steps?))/i.test(clean);
    const routerClaim = /\b(?:both\s+)?(?:openwrt|routers?|anansi|arachne)\b/i.test(line);
    if (routerClaim && (strong || /\b(?:both|configured|functions|operates|provides|default\s+route)\b/i.test(line))) {
      const both = /\bboth\b|\banansi\b.*\barachne\b/i.test(line);
      const cov = ledger.routerCoverage();
      if ((both && !(cov.anansi && cov.arachne)) || (!both && !ledger.has('routers')))
        topics.push('router status not observed for required target(s)');
    }
    if (/\b(?:ollama\s+models?|model\s+(?:inventory|identified|listing))\b/i.test(line) &&
        !ledger.has('ollama_models')) topics.push('Ollama model inventory not observed');
    if (/\b(?:ollama\s+status|ollama.*operational)\b/i.test(line) &&
        !ledger.has('ollama_models')) topics.push('a running Ollama container does not establish Ollama API/model status');
    if (inferred && !/\b(?:not\s+tested|unknown|unverified|needs?\s+verification|cannot\s+determine)\b/i.test(line))
      topics.push('single-subnet, isolation and cross-boundary conclusions require targeted evidence');
    if (taskCount) topics.push('task-completion count requires ledger-derived verification coverage');
    if (/\b(?:all\s+(?:discovered\s+)?mcp\s+services|mcp\s+(?:status|health|connectivity))\b/i.test(line) &&
        !ledger.has('mcp_health')) topics.push('MCP service health was not independently measured');
    if (!topics.length) return line;
    topics.forEach(x => issues.add(x));
    // Preserve exact observed values, but never silently turn inference into proof.
    // Prefix rather than deleting the claim, so the reader can audit it.
    let corrected = line.replace(/\|\s*(?:Confirmed|Verified|Completed|Passed)\s*\|/gi, '| NOT VERIFIED |')
      .replace(/\bCONFIRMED\b/g, 'NOT VERIFIED').replace(/\bVERIFIED\b/g, 'NOT VERIFIED');
    corrected = corrected.replace(/\b\d+\s*(?:\/|of)\s*\d+\s*(?:tasks?|checks?|steps?)\s*(?:completed|passed)?/ig, 'completion count NOT VERIFIED');
    corrected = corrected.replace(/(Tasks?\s+)(?:\*\*)?(?:completed|passed)(?:\*\*)?\s*:\s*\d+\s*\/\s*\d+/i,'$1completion: NOT VERIFIED');
    if (/^\s*\|/.test(corrected)) return corrected === line ? corrected.replace(/\|\s*(?:Confirmed|Verified|Completed|Passed)\s*\|/i, '| NOT VERIFIED |') : corrected;
    return `UNVERIFIED — ${corrected}`;
  });
  if (!issues.size) return { text: original, issues: [], changed: false };
  lines.push('', '### Automated evidence limitations',
    'The labels above were downgraded because this session did not collect the specific supporting evidence. Tool execution alone does not prove topology or isolation.',
    ...[...issues].slice(0, 6).map(x=>`- NOT VERIFIED: ${x}`));
  return { text: lines.join('\n'), issues: [...issues], changed: true };
}

// Bounded scalar facts survive compaction; they are observations, never claims
// that an entire task is sufficient or independently verified.
export function extractFacts(data, maxFacts=48) {
  const facts=[];
  const walk=(value,path,depth)=>{if(facts.length>=maxFacts||depth>6)return;
    if(value===null||['string','number','boolean'].includes(typeof value)){if(String(value).length<=240&&value!=='[redacted]')facts.push({path,value});return;}
    if(Array.isArray(value)){facts.push({path:path+'.length',value:value.length});for(let i=0;i<value.length;i++)walk(value[i],`${path}.${i}`,depth+1);return;}
    if(value&&typeof value==='object')for(const [k,v] of Object.entries(value)){if(/digest|signature|base64|raw|stderr/i.test(k))continue;
      if(k==='stdout' && typeof v==='string'){for(const line of v.split('\n')){const m=line.match(/^([\w@\[\].-]+)=(.*)$/);if(m && m[2]!=='[redacted]' && m[2].length<=240)walk(m[2],`config.${m[1]}`,depth+1);}continue;}walk(v,path?`${path}.${k}`:k,depth+1);}
  };walk(redact(data),'',0);return facts;
}
