// Pi-owned, read-only MCP endpoint validation, configured from operator-owned
// mcp.json. Never accept endpoints or credentials from model arguments.
import { readFileSync } from 'node:fs';
export const MCP_HEALTH_NAME = 'mcp_endpoint_health';
const DEFAULT_CONFIG = '/home/pi/.pi/agent/mcp.json';

function decodeReply(str) {
  const trimmed = str.trim();
  if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed); } catch { return null; } }
  for (const line of str.split(/\r?\n/)) if (line.startsWith('data: ')) {
    try { const msg = JSON.parse(line.slice(6)); if (msg?.jsonrpc === '2.0') return msg; } catch {}
  }
  return null;
}
export function createMcpEndpointHealthTool({ configPath = process.env.PI_MCP_CONFIG_PATH || DEFAULT_CONFIG, fetchImpl = fetch, readConfig = readFileSync, timeoutMs = 3500 } = {}) {
  return {
    name: MCP_HEALTH_NAME,
    label: 'Verify MCP Endpoint Handshakes',
    description: 'Read-only MCP server health: perform protocol initialize handshake with each configured MCP HTTP endpoint (system, security, google, searxng, playwright, memory); report handshake and authentication states, not just Docker status. No tool calls, mutation, arbitrary URLs or model-supplied endpoints.',
    exposure: 'deferred', annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: { type:'object', properties:{}, additionalProperties:false },
    async execute(_id, _args = {}, signal) {
      let servers;
      try { servers = JSON.parse(readConfig(configPath, 'utf8')).mcpServers; }
      catch(e) { return { isError: true, content:[{ type:'text', text:JSON.stringify({ status:'unavailable', reason:'MCP configuration is unreadable', detail:String(e?.code || 'invalid config') }) }] }; }
      const entries = Object.entries(servers ?? {}).filter(([,v]) => v?.enabled !== false && typeof v?.url === 'string').slice(0,12);
      async function check([name, config]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const cancel = () => controller.abort();
        signal?.addEventListener?.('abort', cancel, { once:true });
        try {
          const uri = new URL(config.url);
          if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password || !/^[-a-z0-9_]+$/i.test(name))
            return { name, state:'invalid_configuration' };
          const response = await fetchImpl(uri.href, {
            method:'POST', redirect:'manual', signal:controller.signal,
            headers:{ 'content-type':'application/json', 'accept':'application/json, text/event-stream' },
            body:JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{ name:'pi-endpoint-health', version:'1.0' } } }),
          });
          if (response.status === 401 || response.status === 403) return {name, state:'authentication_required', http_status:response.status};
          if (!response.ok) return {name, state:'http_error', http_status:response.status};
          // MCP streamable HTTP can return a persistent event stream; consume a
          // bounded first chunk instead of waiting for the connection to close.
          const reader = response.body?.getReader?.();
          if (!reader) return {name, state:'unverified_response', http_status:response.status};
          const {value,done} = await reader.read();
          try { await reader.cancel(); } catch {}
          const raw = done ? '' : new TextDecoder().decode(value).slice(0,8192);
          const message = decodeReply(raw);
          const ready = message?.jsonrpc === '2.0' && message.id === 1 &&
            typeof message.result?.protocolVersion === 'string' && typeof message.result?.capabilities === 'object';
          return {name, state:ready ? 'handshake_ok':'unverified_response', http_status:response.status,
            ...(ready ? { protocol_version:message.result.protocolVersion } : {})};
        } catch(e) {
          return {name, state:'unreachable', error:e?.name === 'AbortError' ? 'timeout':String(e?.code || e?.message || 'request failed').slice(0,100)};
        } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', cancel); }
      }
      const results = await Promise.all(entries.map(check));
      const ok = results.filter(x=>x.state === 'handshake_ok').length;
      return {content:[{type:'text', text:JSON.stringify({status:ok === results.length && ok ? 'ok':'partial', source:'mcp_initialize', checked:results.length, verified:ok, endpoints:results})}]};
    }
  };
}
