// Cross-tool loop detection. State lives in the extension process only; never
// projected into provider tool declarations or historical messages.
import { createHash } from 'node:crypto';
import { classifyOutcome } from './outcome.js';

const NOISE = new Set(['mcp', 'tool', 'tools', 'please', 'find', 'available', 'operation', 'server', 'using', 'for', 'the', 'a', 'an', 'on', 'in', 'to', 'of', 'and', 'with', 'get', 'show']);
const DANGEROUS = new Set(['delete', 'remove', 'erase', 'destroy', 'kill', 'stop', 'send', 'write', 'modify', 'exploit', 'attack', 'bruteforce', 'format']);
const STEM = { targets:'target', clients:'client', aliases:'alias', logs:'log', containers: 'container', images: 'image', models: 'model', interfaces: 'interface', resources: 'resource', nodes: 'node', services: 'service', routers: 'router', files: 'file', lists: 'list', listing: 'list', searching: 'search', discover: 'discovery', status: 'status', hosts: 'host' };
const keywords = value => String(value ?? '').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter(Boolean).map(x => STEM[x] ?? x).filter(x => !NOISE.has(x));
const normalize = value => keywords(value).join(' ');
const digest = data => createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex').slice(0, 16);
function operationWords(tool) {
  return keywords(tool.name).filter(x => !['mcp'].includes(x));
}

// Explicit server routing only applies to a LEADING server qualifier. A word
// such as "memory" in "system host cpu memory" means RAM, not memory MCP.
const SERVERS = new Set(['system', 'security', 'memory', 'playwright', 'searxng', 'google']);
const OPERATION_ALIASES = { router: ['router','openwrt'], anansi: ['openwrt'], arachne: ['openwrt'], list: ['list', 'ls', 'enumerate', 'inventory', 'targets', 'target', 'client'], status: ['status','snapshot','inventory','health'], inventory:['inventory','list','targets'], snapshot: ['snapshot', 'info', 'inspect', 'status'], get: ['get', 'read', 'show'], navigate: ['navigate', 'open'], search: ['search', 'find'], model: ['model', 'models'], container: ['container', 'containers'] };

// A catalog match must satisfy the user's *action*, not merely contain the
// same broad noun. Model-only filters are deterministic and add no schemas to
// the provider request. These families intentionally favor read-only status
// and inventory operations over ambiguous package/actions tools.
function intentFitness(q, name) {
  const has = (...words) => words.every(word => q.includes(word));
  if (q.includes('docker') && (q.includes('container') || q.includes('image'))) {
    if (q.includes('list') || q.includes('inventory') || q.includes('enumerate')) {
      if (!name.includes('list')) return { ok: false, reason: 'Docker inventory needs a list operation, not stats/action' };
      if (q.includes('container') && !name.includes('container')) return { ok: false, reason: 'Requested containers, not images' };
      if (q.includes('image') && !name.includes('image')) return { ok: false, reason: 'Requested images, not containers' };
    }
  }
  const router = q.some(x => ['openwrt','router','anansi','arachne'].includes(x));
  if (router) {
    const logs = q.some(x=>['log','logs','logread'].includes(x));
    if (name.includes('logread') && !logs) return {ok:false,reason:'Router logs do not supply board, interface and route inventory'};
    if (q.some(x=>['target','targets','alias','aliases'].includes(x)) && !name.includes('target')) return {ok:false,reason:'SSH target discovery requires target aliases'};
    if (logs && !name.includes('logread')) return {ok:false,reason:'Requested router logs'};
    if (q.includes('client') && !name.includes('client')) return {ok:false,reason:'Router clients require the client-list operation'};
    if (!q.includes('client') && q.some(x=>['wifi','wireless'].includes(x)) && !name.includes('wifi')) return {ok:false,reason:'Router Wi-Fi requires wireless status'};
    if (q.includes('ubus') && !name.includes('ubus')) return {ok:false,reason:'Requested router ubus operation'};
    if (q.includes('package') && !name.includes('package')) return {ok:false,reason:'Requested router package query'};
    if (q.some(x=>['uci','config','configuration'].includes(x)) && !name.includes('uci')) return {ok:false,reason:'Router configuration requires a UCI operation'};
    if (name.includes('set') && !q.some(x=>['set','change','write','modify'].includes(x))) return {ok:false,reason:'Router configuration reads cannot select a write operation'};
    if (!logs && !q.some(x=>['target','targets','alias','aliases','uci','config','configuration','wifi','wireless','client','package','ubus'].includes(x)) && (!name.includes('status') || name.includes('wifi')))
      return {ok:false,reason:'Router inventory requires structured board/interface/route status; use a specific query for other operations'};
  }
  const hostInventory = q.includes('host') && !q.some(x=>['docker','ollama','router','openwrt','interface','route','gateway','file','logs','log','disk'].includes(x));
  if (hostInventory && !name.includes('snapshot') && !name.includes('system') && !name.includes('cpu'))
    return {ok:false,reason:'Host inventory requires a host snapshot, not interface-only or disk-only observations'};
  if (q.some(x=>['ssdp','llmnr'].includes(x)) && name.includes('mdns') && !name.includes('multicast'))
    return {ok:false,reason:'mDNS-only collection cannot cover SSDP/LLMNR; prefer passive broadcast/multicast observation'};
  const browser = q.some(x=>['browser','playwright','page'].includes(x));
  if (browser && !q.some(x=>['node','memory','history'].includes(x)) && !name.some(x=>['browser','playwright','searxng'].includes(x)) && !(name.includes('web') && name.includes('search')))
    return {ok:false,reason:'Web/browser verification requires a web search or browser operation, not persistent memory search'};
  if (browser && !q.some(x=>['resize','close','click','fill','type','screenshot','tabs','pdf','console','evaluate'].includes(x))) {
    if (name.some(x=>['resize','close','click','fill','type','screenshot','tabs','pdf','console','evaluate'].includes(x)))
      return {ok:false,reason:'Browser inspection requires navigation or page snapshot, not an unrelated browser action'};
    if (q.some(x=>['content','text','snapshot'].includes(x)) && !name.includes('snapshot')) return {ok:false,reason:'Page content is exposed through browser snapshot'};
  }
  if (q.includes('openwrt') || q.includes('router')) {
    if (!q.includes('package') && name.includes('package')) return { ok: false, reason: 'Router inventory is not package inventory' };
    if (!q.some(x => ['change', 'restart', 'install', 'upgrade'].includes(x)) && name.some(x => ['action', 'execute', 'apply'].includes(x)))
      return { ok: false, reason: 'Router inspection cannot select a mutating action' };
  }
  if (q.includes('ollama') || has('model', 'list')) {
    if (name.includes('resource') && !name.includes('model')) return { ok: false, reason: 'MCP resource list is not model inventory' };
    if (q.includes('ollama') && !name.includes('ollama')) return { ok: false, reason: 'Ollama requires its own operation' };
  }
  if (q.some(x => ['os', 'kernel', 'version', 'host'].includes(x)) && !q.some(x => ['docker', 'ollama', 'router', 'openwrt'].includes(x))) {
    if (q.includes('kernel') && !name.includes('snapshot') && !name.includes('system')) return { ok: false, reason: 'Kernel inventory requires a host/system snapshot' };
  }
  return { ok: true };
}
export function parseDiscoveryQuery(query) {
  const raw = String(query ?? '').trim().toLowerCase();
  // Only a literal MCP namespace is binding. Natural-language "system" and
  // "security" are search hints, never hard exclusions of cross-server tools.
  const explicit = raw.match(/^(?:mcp__|mcp\s+)(system|security|memory|playwright|searxng|google)(?:__|\s+__)/);
  const words = raw.replace(/^(?:mcp__|mcp\s+)(?:system|security|memory|playwright|searxng|google)(?:__|\s+__)/, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
  if (!explicit && SERVERS.has(words[0])) words.shift();
  if (!explicit && words[0] === 'mcp' && words[1] !== 'health') words.shift();
  return { explicitServer: explicit?.[1] ?? null, intent: keywords(words.join(' ')), raw };
}

export function relevantDiscovery(query, tool) {
  if (!String(query ?? '').trim()) return { ok: false, score: 0, reason: 'Provide specific action and object' };
  const { explicitServer, intent: q } = parseDiscoveryQuery(query);
  const canonical = String(tool.name??'').toLowerCase();
  const normalized = String(query).trim().toLowerCase();
  if (/^(?:system|host) (?:info|information|overview)$/.test(normalized)) return /(?:^|__)host_snapshot$/.test(canonical) ? {ok:true,score:1000,reason:'Host system overview'} : {ok:false,score:0,reason:'System overview requires a host snapshot'};
  const aliases = tool._meta?.['ai.catalog']?.aliases ?? [];
  if (normalized === canonical || normalized === canonical.replace(/^mcp__[^_]+__/, '') || aliases.some(x=>String(x).toLowerCase()===normalized)) return {ok:true,score:10000,reason:'Exact name or catalog alias'};
  if (/playwright|browser/.test(canonical) && /passive|mdns|llmnr|ssdp|multicast|broadcast/.test(normalized) && !/browser|playwright/.test(normalized)) return {ok:false,score:0,reason:'Browser traffic is not passive LAN observation'};
  const name = operationWords(tool), desc = keywords(tool.description);
  const actualServer = String(tool.name ?? '').match(/^mcp__([a-z0-9]+)__/i)?.[1]?.toLowerCase();
  if (explicitServer && actualServer !== explicitServer) return { ok: false, score: 0, reason: `Wrong explicit MCP namespace: ${explicitServer}` };
  if (!q.length) return { ok: false, score: 0, reason: 'Specify a verb and object' };
  const isMcpHealth = /\bmcp\b.*\b(health|status|connection|connectivity|service)|\b(health|status)\b.*\bmcp\b/.test(String(query ?? '').toLowerCase());
  if (isMcpHealth) return /^(mcp_endpoint_health|mcp__[^_]+__(?:mcp_)?(?:endpoint_health|server_health|connection_health))$/.test(String(tool.name ?? '').toLowerCase())
    ? { ok: true, score: 1000, reason: 'Exact MCP endpoint health operation' }
    : { ok: false, score: 0, reason: 'MCP health requires endpoint handshake, not generic router/multicast/memory operation' };
  if (q.some(x => ['openwrt', 'router', 'anansi', 'arachne'].includes(x)) && !name.some(x => ['openwrt', 'router'].includes(x)))
    return { ok: false, score: 0, reason: 'Router query requires a router operation' };
  if (q.includes('host') && q.includes('cpu') && !name.some(x => ['host', 'system'].includes(x)))
    return { ok: false, score: 0, reason: 'Host CPU inventory cannot match persistent memory operations' };
  const fit = intentFitness(q, name);
  if (!fit.ok) return { ok: false, score: 0, reason: fit.reason };
  if (q.some(x => ['ollama','model'].includes(x)) && name.includes('resource') && !name.includes('model'))
    return { ok: false, score: 0, reason: 'MCP resource listing is not Ollama model inventory' };
  const destructive = name.filter(x => DANGEROUS.has(x));
  if (destructive.some(x => !q.includes(x))) return { ok: false, score: 0, reason: `Unrequested state-changing operation: ${destructive.join(', ')}` };
  if (q.includes('ollama') && !name.includes('ollama')) return { ok: false, score: 0, reason: 'Ollama-specific operation not found' };
  const match = word => name.includes(word) || (OPERATION_ALIASES[word] ?? []).some(x => name.includes(x));
  const nameHits = q.filter(match);
  const descHits = q.filter(x => desc.includes(x));
  const action = q.find(x => ['list','snapshot','get','read','search','find','navigate','delete','status','inspect','inventory'].includes(x));
  if (action && !match(action) && !(name.includes('snapshot') && ['status','inspect','get','read','inventory'].includes(action))) return { ok: false, score: 0, reason: 'Requested action does not match operation' };
  const passiveCapture = q.some(x=>['ssdp','llmnr'].includes(x)) && name.includes('broadcast') && name.includes('multicast') && desc.some(x=>['ssdp','llmnr'].includes(x));
  const contentSnapshot = q.some(x=>['content','page','text'].includes(x)) && name.includes('browser') && name.includes('snapshot');
  const hostSnapshot = (q.includes('kernel') || (q.includes('cpu') && q.includes('memory'))) && name.includes('snapshot');
  if (nameHits.length === 0 && !hostSnapshot && !contentSnapshot && !passiveCapture) return { ok: false, score: 0, reason: 'No matching operation-name terms' };
  if (nameHits.length < Math.min(2, q.length) && descHits.length === 0 && !hostSnapshot && !contentSnapshot && !passiveCapture) return { ok: false, score: 0, reason: 'Insufficient exact action/object coverage' };
  const exactName = String(tool.name ?? '').toLowerCase().includes(q.join('_'));
  const preferred = (((q.includes('host') || (q.includes('cpu') && q.includes('memory'))) && name.includes('snapshot')) || (q.some(x=>['openwrt','router','anansi','arachne'].includes(x)) && name.includes('status')) || (q.some(x=>['content','page'].includes(x)) && name.includes('snapshot'))) ? 30 : 0;
  const score = (passiveCapture ? 30 : 0) + preferred + nameHits.length * 5 + descHits.length + (action && match(action) ? 6 : 0) + (hostSnapshot ? 12 : 0) + (exactName ? 14 : 0);
  return { ok: true, score, reason: 'operation matched' };
}

// Conservative default: active network probing is opt-in at the runtime, not
// merely controlled by wording in the model's prompt. Passive captures and
// observed host/interface data remain available.
// Explicit effect classification. A readOnlyHint is NOT proof of passivity:
// discovery that sends ARP, M-SEARCH, DNS-SD or port probes is active.
// Explicit effect classification. A readOnlyHint is NOT proof of passivity:
// discovery that sends ARP, M-SEARCH, DNS-SD or port probes is active.
export function activeNetworkRisk(tool, args = {}) {
  const name = String(typeof tool === 'string' ? tool : tool?.name ?? '').toLowerCase();
  const desc = String(typeof tool === 'string' ? '' : tool?.description ?? '').toLowerCase();
  const command = String(args?.command ?? args?.cmd ?? args?.script ?? '').toLowerCase();
  const commandActive = /(?:^|[;&|\n])\s*(?:(?:sudo|doas)(?:\s+-[a-z]+)*\s+|timeout\s+\d+[smh]?\s+)*(?:nmap|masscan|zmap|arp-scan|arping|ping|fping|nping|hping3|avahi-browse\s+-r)(?:\s|$|[;&|\n])|\b(?:bash|sh)\s+-[a-z]*c\s+["']\s*(?:nmap|masscan|zmap|arp-scan|arping|ping|fping|nping|hping3)\b|\b(?:proxy[_ -]?arp.*probe|hairpin.*test)\b/.test(command);
  const declaredActive = typeof tool==='object' && tool?.parameters?.['x-pi-effect']==='active_probe';
  const namedActive = /(?:^|_)(?:arp_discover|arp_discovery|arp_sweep|arp_scan|arp_probe|arping|upnp_discover|upnp_probe|ssdp_discover|ssdp_search|port_scan|scan_ports|ping_sweep|nmap|masscan|zmap|probe_gateway_proxy_arp|proxy_arp_probe|hairpin_(?:test|check|probe)|test_hairpin|active_discovery|perform_network_discovery|network_discovery|host_discovery|discover_network|discover_hosts|enumerate_hosts|probe_subnet|subnet_scan|network_sweep)(?:_|$)/.test(name);
  const describedActive = /\b(?:arp (?:sweep|probe|scan)|send(?:s|ing)? (?:m.search|arp|multicast|dns.sd)|active (?:discovery|scan|probe)|probe(?:s|s|ing)? hosts|icmp (?:probe|ping))\b/.test(desc);
  const dnsSdFollowup = /(?:^|_)(?:mdns_discover|dns_sd|dnssd|bonjour_discover)(?:_|$)/.test(name) &&
    (!['passive', 'listen', 'capture'].some(x=>name.includes(x)) || args?.followup !== false || args?.resolve !== false);
  const activeOption = args?.active === true || args?.probe === true || args?.scan === true || args?.followup === true || args?.resolve === true || args?.query === true || args?.mode === 'active';
  // Fail closed on underspecified network enumeration; passive collection
  // must be explicitly named or expose explicit passive mode controls.
  if (declaredActive || namedActive || describedActive || dnsSdFollowup || activeOption || commandActive)
    return 'Active network probing or unspecified network discovery is denied without runtime opt-in and explicit current-turn user authorization';
  return null;
}

// Pi's `bash` runs INSIDE the Pi container; it cannot inventory the Arch host
// or control the host Docker daemon. This is a routing safeguard, not a shell
// sandbox. Workspace shell commands remain available.
export function containerHostCommandRisk(name, args = {}) {
  if (name !== 'bash') return null;
  const command = String(args?.command ?? args?.cmd ?? '').trim();
  if (/(?:^|[;&|\n])\s*(?:\.\/|bash\s+|sh\s+)?[^\s;]*\b(?:SKILL|network-recon)\.md\b|(?:^|[;&|\n])\s*network-recon\s+(?:start|run|exec)\b/i.test(command))
    return 'Skill Markdown is instructions, not an executable. Read the skill and discover its documented tools; do not run a .md file or invent a network-recon command.';
  const hostIntrospection = /(?:^|[;&|\n])\s*(?:(?:sudo\s+)?(?:ip\s+(?:a|addr|address|r|route|link|neigh)|ifconfig\b|route\b|arp\s+-[an]|docker\b|podman\b|ollama\b|ubus\b|uci\b|uname\b|hostnamectl\b|lscpu\b|free\s+-|lsblk\b|lspci\b|lsusb\b|nmcli\b|systemctl\b|journalctl\b|ss\s+-|netstat\s+-|df\s+-[hH]|ps\s+(?:aux|-[a-z]*e)|cat\s+\/(?:proc\/(?:cpuinfo|meminfo|version|net\/)|sys\/class\/net\/)))\b/i;
  return hostIntrospection.test(command) ? 'Pi bash is container-local; use system/security MCP for host OS, Docker, Ollama, routes, OpenWrt and physical network interfaces. Do not infer host facts from container eth0 or /proc' : null;
}

export function toolSignature(name, args = {}) {
  if (name === 'tool_search') return `search:${normalize(args?.query)}`;
  return `${name}:${digest(args)}`;
}

function resultFingerprint(result) {
  const content = result?.content ?? [];
  const trimmed = content.map(block => block?.type === 'text'
    ? { type: 'text', text: String(block.text ?? '').slice(0, 24000)
        .replace(/result:[a-z0-9_\/-]+/ig, 'result:REF')
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/ig, 'UUID') }
    : { type: block?.type, mimeType: block?.mimeType });
  return digest([Boolean(result?.isError), trimmed]);
}

export class ProgressGuard {
  constructor({ maxCalls = 120, repeatLimit = 3, navigationRetryLimit = 2, maxBlocked = 10, maxRepeatedBlocks = 4 } = {}) {
    this.options = { maxCalls, repeatLimit, navigationRetryLimit, maxBlocked, maxRepeatedBlocks }; this.reset();
  }
  reset() {
    this.calls = 0; this.attempts = 0; this.blocked = 0; this.searches = 0; this.executions = 0;
    this.consecutiveBlocked = 0; this.blockedSignatures = new Map(); this.hardStopped = false; this.stopReason = null;
    this.progress = 0; this.outcomes = new Set(); this.signatures = new Map();
    this.queryStates = new Map(); this.lastResults = new Map(); this.failures = new Map();
    this.repeatedOutcomes = 0; this.relevanceRejects = 0; this.lastBlock = null;
  }
  markAttempt(event) {
    if (event?.parentToolCallId) return;
    this.attempts++;
    if (this.attempts > (this.options.maxCalls > 16 ? this.options.maxCalls - 8 : this.options.maxCalls)) this.trip(`Per-turn tool budget exhausted: ${this.options.maxCalls} attempted calls including rejected calls.`);
  }
  trip(reason) { if (!this.hardStopped) { this.hardStopped = true; this.stopReason = reason; } }
  rejectEvent(event, reason, { attempted = false } = {}) {
    if (!attempted) this.markAttempt(event);
    this.blocked++; this.consecutiveBlocked++; this.lastBlock = reason;
    const key = toolSignature(event.toolName, event.input);
    const count = (this.blockedSignatures.get(key) ?? 0) + 1;
    this.blockedSignatures.set(key, count);
    if (count >= this.options.maxRepeatedBlocks) this.trip(`Repeated rejection of ${event.toolName} (${count} attempts): ${reason}`);
    if (this.consecutiveBlocked >= this.options.maxBlocked) this.trip(`Repeated tool rejections without execution (${this.consecutiveBlocked}).`);
    if (this.blocked >= this.options.maxCalls) this.trip(`Hard limit: ${this.options.maxCalls} blocked attempts.`);
    return { block: true, hardStop: this.hardStopped,
      reason: this.hardStopped ? `Tool execution halted: ${this.stopReason} Report only evidence already obtained; mark the rest NOT TESTED.`
        : `${reason} Change approach or report verified partial work; do not repeat the same call.` };
  }
  beforeCall(event) {
    if (event.parentToolCallId) return;
    this.markAttempt(event);
    const name = event.toolName, args = event.input ?? {}, key = toolSignature(name, args);
    const reject = reason => this.rejectEvent(event, reason, { attempted: true });
    if (this.hardStopped) return reject(this.stopReason);
    if (this.attempts > this.options.maxCalls) return reject(`Attempt budget exhausted (${this.options.maxCalls}).`);
    if (this.calls >= this.options.maxCalls) return reject(`Per-turn tool budget exhausted (${this.options.maxCalls} calls).`);
    if (name === 'tool_search') {
      const q = normalize(args.query);
      if (q) {
        const old = this.queryStates.get(q);
        if (old?.rejected) return reject(`Discovery already found no relevant operation for ${JSON.stringify(args.query)}. Refine the query or report unavailable.`);
        if (old && old.count >= 2 && old.progress === this.progress)
          return reject(`Repeated discovery without new evidence: ${JSON.stringify(args.query)}.`);
      }
    } else {
      const target = name === 'tool_invoke' ? args?.name || '' : name;
      const invokeKey = toolSignature(target, name === 'tool_invoke' ? args?.arguments : args);
      const previous = this.lastResults.get(invokeKey);
      if (!['result_get','result_list','result_search'].includes(target) && args.refresh !== true && previous?.repeat >= this.options.repeatLimit - 1)
        return reject(`The same tool and arguments already produced repeated identical results (${target}).`);
      if (/browser_navigate|navigate_page/.test(target) && (this.failures.get(invokeKey) ?? 0) >= this.options.navigationRetryLimit)
        return reject(`Repeated navigation to the same URL failed (${target}); do not reopen it.`);
    }
    this.calls++; this.consecutiveBlocked = 0;
    if (name === 'tool_search') this.searches++;
    if (name === 'tool_invoke') this.executions++;
    this.signatures.set(key, (this.signatures.get(key) ?? 0) + 1);
  }
  searchCompleted(query, { rejected = false } = {}) {
    const q = normalize(query); if (!q) return;
    const old = this.queryStates.get(q) ?? { count: 0, progress: this.progress, rejected: false };
    old.count++; old.progress = this.progress; old.rejected ||= rejected;
    if (rejected) this.relevanceRejects++;
    this.queryStates.set(q, old);
  }
  invocationCompleted(name, args, result) {
    const key = toolSignature(name, args);
    const fingerprint = resultFingerprint(result);
    const previous = this.lastResults.get(key);
    const repeat = previous?.fingerprint === fingerprint ? previous.repeat + 1 : 0;
    this.lastResults.set(key, { fingerprint, repeat });
    if (repeat) this.repeatedOutcomes++;
    const isError = !classifyOutcome(result).usable || (result?.content ?? []).some(x =>
      x?.type === 'text' && /(?:net::err_|error page|ERR_CONNECTION|navigation failed|failed to navigate|page unavailable|page crashed|access denied|404 not found)/i.test(x.text ?? ''));
    if (isError) this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    else this.failures.delete(key);
    // A distinct successful result counts as evidence; a repeated resource
    // listing or failed navigation never clears discovery-loop protection.
    const evidence = `${name}:${fingerprint}`;
    const novel = !isError && !this.outcomes.has(evidence);
    if (novel) { this.progress++; this.outcomes.add(evidence); this.blockedSignatures.clear(); this.consecutiveBlocked = 0; }
    return { novel, repeat, isError };
  }
  snapshot() { return { calls: this.calls, attempts: this.attempts, blocked: this.blocked, hardStopped: this.hardStopped, stopReason: this.stopReason, searches: this.searches,
    executions: this.executions, uniqueEvidence: this.progress, repeatedOutcomes: this.repeatedOutcomes,
    relevanceRejects: this.relevanceRejects, lastBlock: this.lastBlock }; }
}
