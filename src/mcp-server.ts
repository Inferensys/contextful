import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recallMemory, writeLesson } from "./memory.js";
import { createContextPack, impactAnalysis, searchCode, tracePath, whyChanged } from "./search.js";

const workspaceArg = {
  workspace: z.string().optional().describe("Workspace path. Defaults to the server process current directory.")
};

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "contextful",
    version: "0.1.0"
  });

  server.tool(
    "context_pack",
    "Return a ranked, cited, token-budgeted context pack so the agent can avoid broad file reads.",
    {
      ...workspaceArg,
      query: z.string().describe("Natural-language or exact query."),
      budget: z.number().optional().describe("Approximate token budget. Defaults to 2000."),
      scope: z.string().optional().describe("Optional repo, directory, or task scope.")
    },
    async (params) => jsonContent(await createContextPack(params))
  );

  server.tool(
    "search_code",
    "Search code, docs, symbols, and stored context with lexical, symbol, and graph-aware ranking.",
    {
      ...workspaceArg,
      query: z.string(),
      mode: z.enum(["all", "code", "docs", "symbols", "memory"]).optional(),
      limit: z.number().optional(),
      filters: z.record(z.string(), z.unknown()).optional()
    },
    async (params) => jsonContent(await searchCode({ workspace: params.workspace, query: params.query, limit: params.limit, kind: params.mode || "all" }))
  );

  server.tool(
    "trace_path",
    "Trace graph relationships between files, symbols, modules, and config nodes.",
    {
      ...workspaceArg,
      from: z.string(),
      to: z.string().optional(),
      edge_types: z.array(z.string()).optional(),
      limit: z.number().optional()
    },
    async (params) => jsonContent(await tracePath({ ...params, edgeTypes: params.edge_types }))
  );

  server.tool(
    "impact_analysis",
    "Find likely dependents and tests for a file, symbol, or module.",
    {
      ...workspaceArg,
      symbol_or_file: z.string(),
      limit: z.number().optional()
    },
    async (params) => jsonContent(await impactAnalysis({ workspace: params.workspace, target: params.symbol_or_file, limit: params.limit }))
  );

  server.tool(
    "why_changed",
    "Explain why a file or symbol may have changed by combining current evidence with git history.",
    {
      ...workspaceArg,
      symbol_or_file: z.string(),
      limit: z.number().optional()
    },
    async (params) => jsonContent(await whyChanged({ workspace: params.workspace, target: params.symbol_or_file, limit: params.limit }))
  );

  server.tool(
    "recall_memory",
    "Search the evidence-backed memory ledger for lessons that survived previous agent sessions.",
    {
      ...workspaceArg,
      query: z.string(),
      scope: z.string().optional(),
      limit: z.number().optional()
    },
    async (params) => jsonContent(await recallMemory(params))
  );

  server.tool(
    "write_lesson",
    "Write an evidence-backed lesson to the memory ledger. Loose remember-this notes are rejected.",
    {
      ...workspaceArg,
      claim: z.string(),
      evidence_refs: z.array(z.string()),
      scope: z.string().optional(),
      confidence: z.number().optional(),
      supersedes: z.string().optional()
    },
    async (params) =>
      jsonContent(
        await writeLesson({
          workspace: params.workspace,
          claim: params.claim,
          evidenceRefs: params.evidence_refs,
          scope: params.scope,
          confidence: params.confidence,
          supersedes: params.supersedes
        })
      )
  );

  await server.connect(new StdioServerTransport());
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}
