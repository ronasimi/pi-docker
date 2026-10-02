import fs from 'node:fs';
import { Type } from 'typebox';
import { createMcpAdapter } from 'pi-mcp-adapter';
import { ALLOWED_TOOLS, BoundedGate, gateConfig } from './gate.mjs';
import { installWhiteRabbitReasoning } from './reasoning.mjs';

export default function boundedMcp(pi: any) {
  installWhiteRabbitReasoning(pi);
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
  const restore = (_event: any, ctx: any) => {
    enforce();
    gate.restore(ctx.sessionManager.getBranch());
  };
  pi.on('session_start', restore);
  pi.on('session_tree', restore);
  pi.on('before_agent_start', () => { enforce(); gate.beginTurn(); });
  pi.on('turn_start', enforce);
  pi.on('tool_call', (event: any) => {
    if (!ALLOWED_TOOLS.includes(event.toolName)) return { block: true, reason: 'Optional native tools are disabled. Use mcp_search to discover the capability, then mcp_call.' };
  });
  pi.registerTool({
    name: 'mcp_search', label: 'MCP search',
    description: 'Discover bounded MCP tools for capabilities not directly provided by core tools. Security work should use server=security; the gate also strongly infers security routing when that filter is omitted. Returns up to 3 complete schemas plus hasMore/nextOffset for bounded continuation. Validate schema fit before execution and use mcp_call only with an exact returned tool.',
    executionMode: 'sequential',
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
    description: 'Execute an exact tool previously returned by mcp_search in this conversation. Pass the exact tool name in tool and its arguments separately in args. For an empty schema use {tool: \"exact_name\", args: {}}; never append {} to the tool name. Reuse discovered tools across follow-up messages and status polling. If a result is partial, truncated, paginated, or reports hasMore, continue with its returned cursor/offset or a dedicated summary tool before concluding.',
    executionMode: 'sequential',
    parameters: Type.Object({
      tool: Type.String(),
      args: Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()])),
    }),
    async execute(_id: string, params: any, signal: AbortSignal, _update: any, ctx: any) {
      return gate.serial(() => { context = ctx; return gate.call(params, signal); });
    },
  });
}
