export const THINKING_CONTINUATION_MESSAGE = 'Continue from your previous reasoning. If you intended to call a tool, emit that tool call now. Otherwise continue the workflow. Do not repeat completed MCP calls. Before finalizing a multi-step MCP request, review the original user request and ensure every explicitly requested capability has either a successful relevant tool call or its own exhausted mcp_search. Search any still-outstanding capability separately; do not skip earlier requested steps.';

function blocksOf(message) {
  if (!message) return [];
  if (Array.isArray(message.content)) return message.content;
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return [];
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.thinking === 'string') return block.thinking;
  if (typeof block.reasoning === 'string') return block.reasoning;
  return '';
}

export function isThinkingOnlyAssistant(message) {
  if (!message || message.role !== 'assistant') return false;
  if (message.stopReason && message.stopReason !== 'stop') return false;
  const blocks = blocksOf(message);
  let hasThinking = false;
  for (const block of blocks) {
    const type = String(block?.type ?? '').toLowerCase();
    if (type === 'thinking' || type === 'reasoning' || type === 'analysis') {
      if (blockText(block).trim()) hasThinking = true;
      continue;
    }
    if (type === 'text') {
      if (blockText(block).trim()) return false;
      continue;
    }
    if (type.includes('tool') || block?.name || block?.arguments) return false;
    // Any other substantive assistant content should count as visible/output
    // rather than triggering an automatic hidden continuation.
    if (blockText(block).trim()) return false;
  }
  return hasThinking;
}

export function lastAssistant(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return undefined;
}

export function thinkingOnlyBoundaryResult(event, alreadyUsed = false) {
  // Do not gate on the incoming boundary context's canContinue flag. At
  // agent_before_settle an ordinary completed assistant response naturally
  // ends with role=assistant, so Pi reports canContinue=false *before* our
  // draft is applied. The hidden custom_message below is converted to a user
  // message; Pi then rebuilds the boundary context and validates continuation.
  // Rejecting the pre-draft false value prevents this guard from ever firing.
  if (alreadyUsed || event?.outcome !== 'completed') return undefined;
  const messages = event?.context?.contextMessages ?? event?.context?.llmMessages ?? [];
  const message = lastAssistant(messages);
  if (!isThinkingOnlyAssistant(message)) return undefined;
  return {
    entries: [
      ...(Array.isArray(event.entries) ? event.entries : []),
      {
        type: 'custom_message',
        customType: 'mcp-thinking-continuation',
        content: THINKING_CONTINUATION_MESSAGE,
        display: false,
        details: { source: 'mcp-gate', reason: 'thinking-only-stop' },
      },
    ],
    continue: true,
  };
}

export const WORKFLOW_CONTINUATION_LIMIT = 5;

export function workflowContinuationBoundaryResult(event, workflowStatus = [], continuationCount = 0) {
  if (event?.outcome !== 'completed' || continuationCount >= WORKFLOW_CONTINUATION_LIMIT) return undefined;
  const outstanding = (workflowStatus ?? []).filter(item => item?.status === 'outstanding');
  if (!outstanding.length) return undefined;
  const next = outstanding[0];
  const remaining = outstanding.map(item => item.stage).join(', ');
  const action = next.discovered
    ? `Call the already-discovered ${next.tool} tool with arguments matching its schema.`
    : `Run mcp_search with {query: "${next.query}", server: "security"}, inspect the returned schema, then call the exact matching tool.`;
  const content = `The requested multi-step network workflow is not complete. Outstanding capabilities: ${remaining}. Next required capability: ${next.stage}. ${action} Do not finalize or claim the capability is unavailable unless its dedicated search has been exhausted. Do not substitute a lower-level related tool for this stage.`;
  return {
    entries: [
      ...(Array.isArray(event.entries) ? event.entries : []),
      {
        type: 'custom_message',
        customType: 'mcp-workflow-continuation',
        content,
        display: false,
        details: { source: 'mcp-gate', reason: 'incomplete-network-workflow', stage: next.stage, tool: next.tool },
      },
    ],
    continue: true,
  };
}
