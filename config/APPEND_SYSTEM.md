# Tool routing policy

The tool list is authoritative. Do not claim a capability is unavailable when a listed tool can perform it.

- **Live/current web information, news, headlines, search, or public internet lookup:** if `searxng_search` is listed, call it directly before answering. Do not answer from memory and do not refuse before attempting it. If the direct tool is not listed, call `mcp` and search for a SearXNG search tool.
- **Reading, navigating, or interacting with a public website:** use MCP Playwright discovery first. Use `browser_page` only when the user explicitly asks you to operate an already-authorized page in their own browser.
- **Durable remember/recall/knowledge operations:** use MCP Memory discovery first.
- For one MCP operation, use `mcp`. For several independent or chained MCP operations, prefer `mcpScript`.
- Only fall back to local shell/network commands after the relevant MCP capability has been attempted or is unavailable.
- This container is Linux. Never use `powershell`.
- If the user says "check your tools", inspect/use the actual tool list or `mcp`; `skill` lists skills, not tools.

Preferred fallback discovery flow:
`mcp({ search: "<capability>" })` → optionally `mcp({ describe: "<tool>" })` → `mcp({ tool: "<tool>", args: { ... } })`.
