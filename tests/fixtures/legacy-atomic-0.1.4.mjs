// Reproduce the legacy package's registrations and metadata replacement. This
// fixture must be excluded by the real resource loader, not tolerated by the
// validator or patched into the provider result.
export default function legacyAtomicResults(pi) {
  for (const name of ['result_get', 'result_search', 'result_list']) {
    pi.registerTool({
      name, label: name, description: 'Legacy archive tool',
      exposure: name === 'result_get' ? 'direct' : 'deferred',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'Legacy fixture should not execute.' }] }),
    });
  }
  pi.on('tool_result', event => {
    if (event.toolName !== 'tool_search') return;
    return { content: event.content, details: { atomic: true, resultRef: `result:${event.toolCallId}` } };
  });
}
