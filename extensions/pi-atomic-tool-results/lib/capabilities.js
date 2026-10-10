import { toolSignature } from './progress.js';
// Turn-scoped deterministic discovery budgets. The model cannot bypass a missing
// capability by synonym swapping. Never change provider tool declarations.
export function capabilityForQuery(query) {
  const s = String(query ?? '').toLowerCase().replace(/[_-]/g, ' ');
  if (/\bollama\b|\b(list|running|installed) models?\b/.test(s)) return 'ollama_inventory';
  if (/\bmcp\b.*\b(health|status|connect|available|service)|\b(health|status)\b.*\bmcp\b/.test(s)) return 'mcp_health';
  if (/\b(openwrt|anansi|arachne|router)\b/.test(s)) return 'routers';
  if (/\b(mdns|ssdp|llmnr|multicast|bonjour)\b/.test(s)) return 'passive_network';
  if (/\b(isolation|hairpin|proxy\s*arp|leakage)\b/.test(s)) return 'isolation';
  if (/\b(subnet|topology|reflector)\b/.test(s)) return 'topology';
  if (/\bdocker\b.*\bimage\b/.test(s)) return 'docker_images';
  if (/\bdocker\b/.test(s)) return 'docker_containers';
  if (/\b(interface|ipv4|routes?|gateway)\b/.test(s)) return 'network_interfaces';
  if (/\b(host|kernel|cpu|ram|operating system)\b/.test(s)) return 'host_inventory';
  if (/\b(web|searxng|browser|search engine|online documentation)\b/.test(s)) return 'web_verification';
  return null; // unrelated tool discovery continues through existing guards
}
export function capabilityForOperation(name) {
  const n = String(name ?? '').toLowerCase();
  if (/ollama.*(?:inventory|models|list|tags|status)/.test(n)) return 'ollama_inventory';
  if (/mcp.*(?:health|status|connect)/.test(n)) return 'mcp_health';
  if (/openwrt/.test(n)) return 'routers';
  if (/(?:mdns|ssdp|llmnr|multicast|passive|capture)/.test(n)) return 'passive_network';
  if (/(?:isolation|hairpin|proxy_arp)/.test(n)) return 'isolation';
  if (/(?:topology|subnet)/.test(n)) return 'topology';
  if (/docker.*image/.test(n)) return 'docker_images';
  if (/docker/.test(n)) return 'docker_containers';
  if (/interface|network_route/.test(n)) return 'network_interfaces';
  if (/host_(?:snapshot|cpu|system)|system_info/.test(n)) return 'host_inventory';
  if (/searxng|browser|web_/.test(n)) return 'web_verification';
  return null;
}
export class CapabilityTracker {
  constructor({ maxMisses = 3 } = {}) { this.maxMisses = maxMisses; this.reset(); }
  reset() { this.states = new Map(); }
  state(id) { return this.states.get(id) ?? { state: 'untried', misses: 0, reason: '' }; }
  unavailable(query) { const id = capabilityForQuery(query); return id && this.state(id).state === 'unavailable' ? { id, ...this.state(id) } : null; }
  discovered(query, toolName) {
    const id = capabilityForQuery(query); if (!id) return null;
    const previous = this.state(id);
    if (previous.state === 'executed' || previous.state === 'unavailable') return { id, ...previous };
    const state = toolName ? 'ready' : (previous.misses + 1 >= this.maxMisses ? 'unavailable' : 'untried');
    const next = { state, misses: toolName ? previous.misses : previous.misses + 1, reason: toolName ? `ready: ${toolName}` : 'No matching authorized operation after bounded discovery' };
    this.states.set(id, next); return { id, ...next };
  }
  failedExecution(name, args = {}, errorClass = 'execution') {
    const id = `${name}:${toolSignature(name, args)}:${errorClass}`;
    const old = this.state(id), misses = old.misses + 1;
    const next = {state:misses >= this.maxMisses?'unavailable':'untried',misses,reason:'Operation-specific failure; other targets and arguments remain available'};
    this.states.set(id,next);return {id,...next};
  }
  executed(name, success) {
    const id = capabilityForOperation(name); if (!id || !success || this.state(id).state === 'unavailable') return;
    this.states.set(id, { state: 'executed', misses: this.state(id).misses, reason: `executed: ${name}` });
  }
  summary() { return Object.fromEntries([...this.states].map(([k,v])=>[k,{...v}])); }
}
