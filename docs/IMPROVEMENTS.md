# Contextful Dogfood Findings

These came from running Contextful against its own repo and a temp copy of `mcp-doctor`.

## Fixed Immediately

- Duplicate symbol refs collided in real files. Symbol evidence refs now include the line number.
- Tree-sitter WASM compatibility was broken with the latest `web-tree-sitter`. The package now uses a compatible runtime and probes it during indexing.
- Queries like "where are MCP tools registered" needed intent-aware expansion and ranking. Registration/tool queries now expand toward `server.tool` and MCP server code.
- The local state directory is now branded as `.contextful/`.

## Next Improvements

- Rename internal storage tables toward the public graph model: `nodes`, `edges`, `node_props`, and `edge_props`.
- Replace regex symbol extraction with real tree-sitter queries for JS/TS, Python, Go, and Rust.
- Add graph-aware re-ranking so `context_pack` favors files that connect multiple evidence hits instead of isolated keyword matches.
- Add a `cxf eval` command that runs a saved query set against a repo and reports recall, precision proxy, latency, tool-call savings, and token budget.
- Add optional adapters for existing indexes such as Sourcegraph, Graphify exports, and Neo4j without making them required.
- Add a compact TUI or HTML graph report for inspecting evidence packs and stale memories.
- Add branch-aware and commit-aware memory validation so lessons can be scoped to a revision range.
- Add shell completion and short aliases for frequent commands: `cxf q`, `cxf i`, `cxf mem`.
- Add optional local semantic vectors via sqlite-vec, LanceDB, or HNSW once the lexical/symbol/graph baseline is strong.
