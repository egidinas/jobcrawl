# jobcrawl as an MCP server

`jobcrawl mcp` serves a data folder to an AI agent over the Model Context Protocol (stdio, JSON-RPC 2.0, one message per line).
It is **read-only**: no tool writes the store, a file or a consumer bookmark. The protocol is implemented in about 150 lines
(`core/mcp/protocol.mjs`) with no dependency: a read-only tool server needs only `server/discover`, `tools/list`, `tools/call` and
`ping`, and an SDK would add a dependency tree to an engine whose goal is near-zero dependencies.

```sh
jobcrawl mcp --data <dir> [--store sqlite|json] [--allow-crawl]
```

`--store` defaults to what the folder holds (`store.sqlite` means sqlite). The store is opened read-only (`readOnly` plus
`PRAGMA query_only`); a folder without a store is an error (exit 4), never created. `--help` prints the usage and does nothing else.
stdout carries JSON-RPC lines only; logs and any stray console output go to stderr. The server exits when stdin closes.

## Client configuration

```json
{
  "mcpServers": {
    "jobcrawl": {
      "command": "node",
      "args": ["/opt/jobcrawl/cli/jobcrawl.mjs", "mcp", "--data", "/var/lib/jobcrawl"]
    }
  }
}
```

With the package installed: `"command": "npx", "args": ["jobcrawl", "mcp", "--data", "/var/lib/jobcrawl"]`.
Node 22.5 or newer (`node:sqlite`).

## Protocol

Pinned current revision: **2026-07-28** (stateless: every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and
`_meta["io.modelcontextprotocol/clientCapabilities"]`; results carry `resultType`; an unknown version gets error `-32022` with
`data.supported`). The server is dual-era: a client that starts with `initialize` gets the legacy handshake and the revisions
2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05. Not implemented: resources, prompts, subscriptions, tasks, input-required results.
JSON-RPC batches are refused (`-32600`). Errors: `-32700` parse, `-32600` invalid request or not initialized, `-32601` unknown method,
`-32602` invalid params or unknown tool, `-32022` unsupported version. A tool's own failure (bad arguments, unknown board) is a result
with `isError: true`.

## Tools (read-only)

| tool | does |
|---|---|
| `detect_board {url?, html?, page_url?}` | Which ATS source reads this URL or this HTML. **Offline**: nothing is fetched, no name is resolved. |
| `get_delta {stream?, after?, consumer?, since_seq?, limit?, fields?}` | Delta events (`added`, `changed`, `reappeared`, `departed`, `board-ok`, `board-failed`) or the resolved stream after a cursor. `consumer` reads a stored bookmark (never moves it). `next_cursor` is the cursor of the last row returned. |
| `search_postings {query, board?, status?, location?, limit?, fields?}` | BM25-ranked full text (SQLite FTS5) over title, company, location and the stored excerpt (`posting_text`). Terms are ANDed, the last is a prefix; query text is never FTS syntax. The index is in memory and rebuilt when the store's last `event_id` moves. |
| `explain_board_health {board?, reads?, limit?}` | State, last reads, error classes, consecutive failures, breaker and host cooldown, a suggested next step. Without a board: all boards, worst first. |

Excerpts exist only for stores written with text on (`--no-excerpt` off, `store.excerpt`, or `JOBCRAWL_STORE_TEXT=1`).

With `--allow-crawl` (network tools; every request goes through the engine egress guard `core/fetch/guard.mjs`, installed at the entry
point): `detect_page {url}` (detect on the live careers page: one GET, every redirect hop vetted) is implemented; `discover`,
`crawl_board` and `propose_config` are registered but answer `status: "unsupported"` in this release. The guard refuses non-http(s),
credentials in URLs, `localhost`, loopback, private, link-local, CGNAT, metadata and mapped addresses, and names that resolve to them
(checked again after the response headers). **MCP does not honour `JOBCRAWL_ALLOW_PRIVATE_TARGETS`**: an agent can never aim the
server at the intranet. Without the flag these tools do not exist (`tools/list` omits them; calling one is `-32602`).

## Guardrails

- **Untrusted text.** Postings are scraped third-party text. Results that carry it have `untrusted: true` and a `notice` at the top
  level, `untrusted: true` on each row, and every tool description says so. An agent must treat the content as data.
- **Invisible characters are stripped** from every string before it leaves the server: zero-width characters, bidi controls,
  U+2028/2029, Unicode tag characters (U+E0000 to E01EF), other control characters and lone surrogates. This is one choke point in
  `tools/call`, applied to the text content and the structured content alike.
- **Size caps.** `limit` is at most 200; one result is at most about 48 KB (rows beyond it are dropped, `truncated: true`, and
  `next_cursor` points at the last row returned); strings are capped (title 300, excerpt 1,200 characters, error detail 300); an input line
  is at most 1 MiB; `detect_board` HTML at most 1,000,000 characters.
- **Field allowlist** (`core/outputs/fields.mjs`). Rows are built with `project(...)` from the allowlisted fields; event bodies and board
  states are never copied. Private names (fit, score, rating, notes, contacts, salary, ...) and unknown names are refused in `fields`;
  `description` is not available over MCP, only the excerpt.
- **No write tools.** There are none, not even behind a flag. `add_board` and `apply_config` from the design are not part of this server.

## Examples

```jsonc
// 2026-07-28 request
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_postings","arguments":{"query":"thermal engineer","limit":5},
 "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
```

Page through changes: call `get_delta {"limit": 100}`, keep `next_cursor`, call again with `{"after": <next_cursor>}` until `has_more` is false.
