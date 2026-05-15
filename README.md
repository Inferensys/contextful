![contextful cover image](docs/cover.svg)

# contextful

**Most-efficient Context Management Layer for Agentic AI.**

Contextful is a runtime contextual layer agents need for real projects. Available as an MCP, it integrates with Codex, Claude Code, Cursor, Windsurf, GitHub Copilot, VS Code, Cline, Roo Code, Continue, and Zed, then gives agents one fast way to find, compress, cite, and remember project context.

Instead of making an agent read 40 files every session, Contextful indexes the project once and returns a ranked, cited, token-budgeted **context pack**.

## Why Agents Need This

- **100x more efficient token usage:** stop paying tokens to re-read the same files.
- **Fewer tool calls:** one context pack can replace dozens of grep, glob, and read-file calls.
- **No lost context between sessions:** agents can store session learnings in an evidence-backed memory ledger.
- **Shareable project knowledge:** lessons and context packs survive context compaction and future sessions.

## Core

### Search Engine

Contextful analyzes the query, classifies intent, and combines lexical search, symbols, docs, graph relationships, and memory hits to retrieve the right evidence. The goal is Google-level project search for agents: vague queries like "resources for auth onboarding" should still land on the right code, docs, and prior lessons.

### Efficient Context Storage

The default local store is SQLite with FTS-backed search and typed graph tables. V1 ships with:

- SQLite as the default local store.
- FTS5 lexical/BM25 search.
- Typed graph tables: `nodes`, `edges`, `node_props`, `edge_props`.
- A hot adjacency cache for common graph relations.
- Deterministic structural fingerprints inspired by Code2Vec-style secondary reranking signals.

The next storage upgrades are optional semantic vectors through sqlite-vec, LanceDB, or local HNSW, and compressed adjacency lists with Roaring bitmaps or CSR arrays for larger repositories.

### Memory Ledger

Agents can store lessons, decisions, and useful project facts, but not as loose "remember this" notes. Every memory requires evidence refs from files, symbols, commits, or prior context packs. When the evidence changes, Contextful marks the memory stale.

### Runtime Architecture

Contextful is an MCP server, local indexer, and small CLI:

- **MCP server:** the agent interface.
- **Local daemon / watcher:** indexing, rebuilds, freshness, and future benchmarks.
- **CLI (`cxf`):** human debugging, reports, memory writes, and local smoke tests.

MCP is the right interface because tools, resources, and prompts are exactly what MCP standardizes. The agent asks for context; Contextful returns compact evidence.

## Install

```bash
npx @inferensys/contextful index --workspace .
npx @inferensys/contextful query "where is user auth handled" --workspace . --budget 2000
```

Run as an MCP server:

```bash
npx @inferensys/contextful server
```

## CLI

The primary binary is `cxf`; `contextful` is also provided as a readable alias.

```bash
cxf index --workspace <path> [--watch]
cxf daemon --workspace <path>
cxf query "<query>" --workspace <path> --budget 2000 --json
cxf report --workspace <path> --format markdown|json|html
cxf memory add --workspace <path> --claim <text> --evidence <ref>
cxf server
```

## Core MCP Tools

Keep the agent surface small:

- `context_pack(query, budget, scope)` - the killer tool. Returns a ranked, cited, token-budgeted bundle instead of forcing 40 random file reads.
- `search_code(query, mode, filters)` - powerful code, docs, symbol, and memory search.
- `trace_path(from, to, edge_types)` - graph traversal across files, symbols, modules, and config.
- `impact_analysis(symbol_or_file)` - reverse dependencies and likely tests.
- `why_changed(symbol_or_file)` - current evidence plus git history.
- `recall_memory(query, scope)` - search session learnings and durable project lessons.
- `write_lesson(claim, evidence_refs, scope)` - store an evidence-backed memory.

## MCP Client Setup

Use this stdio server command in any MCP-aware coding tool:

```json
{
  "mcpServers": {
    "contextful": {
      "command": "npx",
      "args": ["-y", "@inferensys/contextful", "server"]
    }
  }
}
```

Codex:

```bash
codex mcp add contextful -- npx -y @inferensys/contextful server
```

## Viral Receipts

Contextful reports should make the value visible:

- "Context pack saved 18 tool calls."
- "100k+ tokens avoided by not re-reading files."
- "2x faster context gathering."
- "3 session learnings reused from the memory ledger."

## Privacy

V1 is local-only. It does not call external embedding APIs, upload source code, edit source files, auto-fix code, or install dependencies inside the target workspace.

## Evidence Refs

Memory writes require evidence references returned by search or context packs:

- `file:src/auth.ts:10-40`
- `symbol:src/auth.ts#AuthService:12`
- `pack:ctx_...`

Invalid or stale evidence is rejected or marked stale.
