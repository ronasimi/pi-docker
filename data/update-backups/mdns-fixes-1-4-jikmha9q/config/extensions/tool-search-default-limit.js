/**
 * Runtime guard for Pi native deferred discovery.
 *
 * Pi 1.0's built-in tool_search defaults an omitted `limit` to 8. Small local
 * models frequently omit the field even when the prompt asks for `limit: 1`.
 * Mutate only omitted/null limits at the official `tool_call` hook so explicit
 * caller choices (for example limit: 3 for broad discovery) remain unchanged.
 */
export default function toolSearchDefaultLimit(pi) {
  pi.on('tool_call', (event) => {
    if (!event.input || typeof event.input !== 'object') return;
    if (event.toolName === 'tool_search' && event.input.limit == null) {
      event.input.limit = 1;
      return;
    }
    if (event.toolName === 'mcp__security__get_host_interface_info' && event.input.interface == null) {
      delete event.input.interface;
    }
  });
}
