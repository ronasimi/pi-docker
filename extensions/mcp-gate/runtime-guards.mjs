export const THINKING_CONTINUATION_MESSAGE = 'Continue from your previous reasoning. If you intended to call a tool, emit that tool call now. Otherwise provide the final answer. Do not repeat completed MCP calls. For a multi-step MCP request, continue with the next outstanding capability and search for that capability if needed.';

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
  if (alreadyUsed || event?.outcome !== 'completed' || event?.context?.canContinue === false) return undefined;
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
