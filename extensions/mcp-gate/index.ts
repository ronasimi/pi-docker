import fs from 'node:fs';
import { Type } from 'typebox';
import { createMcpAdapter } from 'pi-mcp-adapter';
import { ALLOWED_TOOLS, BoundedGate, gateConfig } from './gate.mjs';
import { installWhiteRabbitReasoning } from './reasoning.mjs';
import { thinkingOnlyBoundaryResult, workflowContinuationBoundaryResult } from './runtime-guards.mjs';

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
  let thinkingContinuationUsed = false;
  let workflowContinuationCount = 0;
  const restore = (_event: any, ctx: any) => {
    enforce();
    thinkingContinuationUsed = false;
    workflowContinuationCount = 0;
    gate.restore(ctx.sessionManager.getBranch());
  };
  pi.on('session_start', restore);
  pi.on('session_tree', restore);
  pi.on('before_agent_start', (event: any) => { enforce(); thinkingContinuationUsed = false; workflowContinuationCount = 0; gate.beginTurn(event.prompt); });
  pi.on('turn_start', enforce);
  pi.on('tool_call', (event: any) => {
    if (!ALLOWED_TOOLS.includes(event.toolName)) return { block: true, reason: 'Optional native tools are disabled. Use mcp_search to discover the capability, then mcp_call.' };
  });
  pi.on('agent_before_settle', (event: any) => {
    const workflowResult = workflowContinuationBoundaryResult(event, gate.networkWorkflowStatus(), workflowContinuationCount);
    if (workflowResult) {
      workflowContinuationCount++;
      return workflowResult;
    }
    const result = thinkingOnlyBoundaryResult(event, thinkingContinuationUsed);
    if (result) thinkingContinuationUsed = true;
    return result;
  });
  pi.registerTool({
    name: 'mcp_search', label: 'MCP search',
    description: 'Discover bounded MCP tools for one capability query. Prefer the canonical query string. If a small model emits queries:[...], the gate executes only the first entry and reports the rest as deferred; it never batches capability searches. Security work should use server=security. Returns up to 3 ranked schemas plus hasMore/nextOffset. Results are query matches, not a server catalog: search every different outstanding capability separately before claiming it is unavailable. Validate schema fit and call only an exact returned tool.',
    executionMode: 'sequential',
    parameters: Type.Object({
      // `query` is canonical. `queries` is a narrow compatibility alias for
      // small local models that occasionally pluralize the field. Both are
      // optional at schema-validation time so the gate can normalize/reject
      // deterministically instead of Pi rejecting the call before execution.
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Canonical single capability query. Prefer this field.' })),
      queries: Type.Optional(Type.Array(
        Type.String({ minLength: 1, maxLength: 200 }),
        { minItems: 1, maxItems: 6, description: 'Compatibility alias for small-model serialization. The gate executes only the first string; remaining entries are returned as deferred and must be searched separately. Do not use for batching.' },
      )),
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
    description: 'Execute an exact tool previously returned by mcp_search in this conversation. Pass the exact tool name in tool and arguments separately in args; for no arguments use {tool: \"exact_name\", args: {}} and never append {} to the name. Reuse discovered tools across follow-ups. If a small model accidentally omits tool, the gate may recover only when one already-discovered schema matches args unambiguously; otherwise the call fails safely. A successful call completes only that capability: on multi-step requests, continue searching/calling every other explicit requested capability before finalizing. For network-map workflows, complete every explicitly requested host/discovery/topology/wireless stage first; the gate then injects those exact successful results into the map tool as args.data and never forwards a native Pi workspace input_path. Successful read-only calls with equivalent/default arguments are blocked from repeating in the same user turn unless the user explicitly asks for a fresh rerun; status/poll tools remain repeatable. Continue partial/paginated results before concluding.',
    executionMode: 'sequential',
    parameters: Type.Object({
      tool: Type.Optional(Type.String()),
      args: Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()])),
    }),
    async execute(_id: string, params: any, signal: AbortSignal, _update: any, ctx: any) {
      return gate.serial(() => { context = ctx; return gate.call(params, signal); });
    },
  });
}
