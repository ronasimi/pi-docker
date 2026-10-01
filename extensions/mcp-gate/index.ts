import fs from 'node:fs';
import { Type } from 'typebox';
import { createMcpAdapter } from 'pi-mcp-adapter';
import { ALLOWED_TOOLS, BoundedGate, gateConfig } from './gate.mjs';

export default function boundedMcp(pi: any) {
  const configPath = process.env.PI_MCP_CONFIG || '/etc/pi/mcp.json';
  const config = gateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  let proxy: any;
  const adapterApi = new Proxy(pi, {
    get(target, key) {
      if (key === 'registerTool') return (tool: any) => { if (tool.name === 'mcp') proxy = tool; };
      if (key === 'setActiveTools') return (names: string[]) => target.setActiveTools(names.filter(n => ALLOWED_TOOLS.includes(n)));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  createMcpAdapter({ config })(adapterApi);
  let callId = 0;
  let context: any;
  const gate = new BoundedGate(config, async (args: any, signal: AbortSignal) => {
    if (!proxy) throw new Error('MCP adapter is not initialized. Reload the session and check startup errors.');
    return proxy.execute(`bounded-mcp-${++callId}`, args, signal, undefined, context);
  });
  const enforce = () => pi.setActiveTools(pi.getActiveTools().filter((name: string) => ALLOWED_TOOLS.includes(name)));
  pi.on('session_start', enforce);
  pi.on('before_agent_start', () => { enforce(); gate.reset(); });
  pi.on('turn_start', enforce);
  pi.on('tool_call', (event: any) => {
    if (!ALLOWED_TOOLS.includes(event.toolName)) return { block: true, reason: 'Optional native tools are disabled. Use mcp_search to discover the capability, then mcp_call.' };
  });
  pi.registerTool({
    name: 'mcp_search', label: 'MCP search',
    description: 'Discover bounded MCP tools for capabilities not directly provided by core tools. Search before shell/network workarounds when an external, infrastructure, or security capability is needed. Servers: security=authorized red-team/blue-team, vulnerability assessment, reconnaissance, security testing, forensics, malware, packet/log and incident analysis; system=Docker/host/network/OpenWrt/image/document; google=Gmail/Calendar/Drive; playwright=browser interaction/live pages; searxng=public web search; memory=durable memory. Returns up to 3 complete schemas; execute exact matches via mcp_call.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      server: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal, _update: any, ctx: any) {
      return gate.serial(() => { context = ctx; return gate.search(params, signal); });
    },
  });
  pi.registerTool({
    name: 'mcp_call', label: 'MCP call',
    description: 'Execute an exact tool returned by mcp_search in this user turn. Supply args matching its schema. Do not call discovered MCP names as native functions. Failed identical calls are blocked; change inputs or discover an alternative.',
    parameters: Type.Object({
      tool: Type.String(),
      args: Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()])),
    }),
    async execute(_id: string, params: any, signal: AbortSignal, _update: any, ctx: any) {
      return gate.serial(() => { context = ctx; return gate.call(params, signal); });
    },
  });
}
