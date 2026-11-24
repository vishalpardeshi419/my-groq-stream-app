# MCP: Model Context Protocol

## What it is

MCP is a standard JSON-RPC protocol between an MCP host (an AI application), a
client connection owned by that host, and MCP servers. A server may expose
tools (actions the model can request), resources (readable context), and prompts
(reusable prompt templates). A compatible host can discover these capabilities
without a bespoke integration for each server.

The protocol overview is at
https://modelcontextprotocol.io/specification/2025-11-25.

## Transports

- **stdio**: the client launches a local server process and exchanges
  newline-delimited JSON-RPC over stdin/stdout. The server must reserve stdout
  for protocol messages; diagnostics belong on stderr.
- **Streamable HTTP**: a remote server receives JSON-RPC via HTTP POST and can
  stream responses using server-sent events. A remote deployment needs
  authentication and origin protections; local HTTP servers should bind only
  to localhost.

The transport specification is at
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.

## This repository's server

`mcp/search-docs.ts` uses the official TypeScript SDK and stdio transport. Its
`search_docs` tool searches `README.md` and Markdown files under `docs/`, with a
typed query and a capped result count. It is intentionally read-only.

Run it from this repository:

```bash
npm run mcp:search-docs
```

Test tool discovery and invocation with the MCP Inspector:

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  npx tsx mcp/search-docs.ts \
  --method tools/list

npx --yes @modelcontextprotocol/inspector --cli \
  npx tsx mcp/search-docs.ts \
  --method tools/call \
  --tool-name search_docs \
  --tool-arg query=transports \
  --format json
```

To connect another stdio client, configure its MCP server command as `npx`,
arguments `["tsx", "/absolute/path/to/this/repository/mcp/search-docs.ts"]`,
and working directory as the repository root.

## Trust boundaries and tradeoffs

MCP removes per-client tool protocol glue: compatible clients can list and call
the same server tool using its schema. It adds server lifecycle management,
protocol and SDK dependencies, and decisions about transport, authentication,
permissions, and logging. Stdio avoids a network listener but still grants the
client access to whatever the server process can read.

Tool descriptions and returned documentation are input from outside the model's
trusted instructions. A client should not blindly follow instructions found in
tool output; the server's own tool code must enforce the actual access boundary.
This tool only reads the repository README and `docs/` Markdown files and
returns a bounded number of short matching lines.
