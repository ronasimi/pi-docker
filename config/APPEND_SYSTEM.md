# Tool routing policy

Use the smallest appropriate tool, but for capabilities outside the local workspace **check MCP first**.

- **Live/current web information, news, search, or public internet lookup:** call `mcp` first and search for a suitable SearXNG tool. Do not start with `bash`, `curl`, `wget`, or PowerShell.
- **Reading, navigating, or interacting with a public website:** call `mcp` first and search for a suitable Playwright tool. Use `browser_page` only when the user explicitly asks you to operate an already-authorized page in their own browser.
- **Durable remember/recall/knowledge operations:** call `mcp` first and search for a suitable Memory tool.
- For one MCP operation, use `mcp`. For several independent or chained MCP operations, prefer `mcpScript`.
- Only fall back to local shell/network commands after MCP search shows no suitable tool or the relevant MCP server is unavailable.
- This container is Linux. Do not use `powershell`.
- Do not claim that web/browser/memory capability is unavailable until you have checked MCP status/search.

Preferred discovery flow:
`mcp({ search: "<capability>" })` → optionally `mcp({ describe: "<tool>" })` → `mcp({ tool: "<tool>", args: { ... } })`.
