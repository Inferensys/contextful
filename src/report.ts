import { closeKernelDb, openKernelDb, listMemories } from "./db.js";
import { getIndexStatus } from "./search.js";
import { type ContextReport, type ReportFormat } from "./types.js";
import { estimateTokens, redactText, resolveWorkspace } from "./util.js";

interface QueryRow {
  query: string;
  intent: import("./types.js").SearchIntent;
  count: number;
}

interface PackRow {
  id: string;
  query: string;
  created_at: string;
  token_estimate: number;
}

export async function generateReport(options: { workspace?: string }): Promise<ContextReport> {
  const workspace = resolveWorkspace(options.workspace);
  const status = await getIndexStatus({ workspace });
  const kernel = openKernelDb(workspace);
  try {
    const topQueries = kernel.db
      .prepare("SELECT query, intent, COUNT(*) AS count FROM queries GROUP BY query, intent ORDER BY count DESC, MAX(created_at) DESC LIMIT 10")
      .all() as QueryRow[];
    const recentPacks = kernel.db
      .prepare("SELECT id, query, created_at, token_estimate FROM evidence_packs ORDER BY created_at DESC LIMIT 10")
      .all() as PackRow[];
    const indexedTokens =
      (kernel.db.prepare("SELECT COALESCE(SUM(token_estimate), 0) AS tokens FROM chunks").get() as { tokens: number }).tokens || 0;
    const averagePackTokens = recentPacks.length
      ? Math.round(recentPacks.reduce((sum, row) => sum + row.token_estimate, 0) / recentPacks.length)
      : 0;
    const estimatedSavingsRatio = averagePackTokens > 0 ? Math.round((indexedTokens / averagePackTokens) * 10) / 10 : 0;
    const estimatedToolCallsSaved = recentPacks.length * 18;
    const estimatedTimeSavedSeconds = estimatedToolCallsSaved * 6;

    return {
      status,
      topQueries: topQueries.map((row) => ({ query: redactText(row.query, workspace), intent: row.intent, count: row.count })),
      staleMemories: listMemories(kernel.db, "stale").slice(0, 20).map((memory) => ({
        ...memory,
        claim: redactText(memory.claim, workspace)
      })),
      recentPacks: recentPacks.map((row) => ({
        id: row.id,
        query: redactText(row.query, workspace),
        createdAt: row.created_at,
        tokenEstimate: row.token_estimate
      })),
      tokenSavingsEstimate: {
        indexedTokens,
        averagePackTokens,
        estimatedSavingsRatio,
        estimatedToolCallsSaved,
        estimatedTimeSavedSeconds
      }
    };
  } finally {
    closeKernelDb(kernel);
  }
}

export function renderReport(report: ContextReport, format: ReportFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "html") return renderHtml(report);
  return renderMarkdown(report);
}

export function renderEvidencePackMarkdown(pack: import("./types.js").EvidencePack): string {
  const lines = [
    `# Context Pack ${pack.id}`,
    "",
    `Query: ${pack.query}`,
    `Intent: ${pack.intent}`,
    `Confidence: ${Math.round(pack.confidence * 100)}%`,
    `Token estimate: ${pack.tokenEstimate}/${pack.budget}`,
    "",
    pack.summary,
    "",
    "## Citations"
  ];
  for (const hit of pack.citations) {
    lines.push(`- ${hit.ref} (${hit.title})`);
    lines.push(`  ${hit.excerpt}`);
  }
  if (pack.graphPaths.length > 0) {
    lines.push("", "## Graph Paths");
    for (const path of pack.graphPaths) {
      lines.push(`- ${path.from} --${path.edgeType}--> ${path.to} (${path.filePath}:${path.line})`);
    }
  }
  if (pack.memoryHits.length > 0) {
    lines.push("", "## Memory Hits");
    for (const hit of pack.memoryHits) lines.push(`- ${hit.ref}: ${hit.excerpt}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(report: ContextReport): string {
  const lines = [
    "# Contextful Report",
    "",
    `Workspace: ${report.status.workspace}`,
    `Indexed at: ${report.status.indexedAt || "not indexed"}`,
    `Files: ${report.status.fileCount}`,
    `Chunks: ${report.status.chunkCount}`,
    `Symbols: ${report.status.symbolCount}`,
    `Graph nodes: ${report.status.graphNodeCount}`,
    `Edges: ${report.status.edgeCount}`,
    `Memories: ${report.status.memoryCount} (${report.status.staleMemoryCount} stale)`,
    "",
    "## Token Savings",
    "",
    `Indexed token estimate: ${report.tokenSavingsEstimate.indexedTokens}`,
    `Average evidence pack: ${report.tokenSavingsEstimate.averagePackTokens}`,
    `Estimated savings ratio: ${report.tokenSavingsEstimate.estimatedSavingsRatio || "n/a"}x`,
    `Estimated tool calls saved: ${report.tokenSavingsEstimate.estimatedToolCallsSaved}`,
    `Estimated time saved: ${report.tokenSavingsEstimate.estimatedTimeSavedSeconds}s`,
    "",
    "## Language Coverage"
  ];

  for (const [language, count] of Object.entries(report.status.languageCounts)) {
    lines.push(`- ${language}: ${count}`);
  }

  lines.push("", "## Top Queries");
  if (report.topQueries.length === 0) lines.push("- No queries recorded yet.");
  for (const query of report.topQueries) {
    lines.push(`- ${query.query} (${query.intent}, ${query.count}x)`);
  }

  lines.push("", "## Stale Memories");
  if (report.staleMemories.length === 0) lines.push("- No stale memories.");
  for (const memory of report.staleMemories) {
    lines.push(`- ${memory.id}: ${memory.claim}`);
  }

  lines.push("", "## Agent Instructions");
  lines.push("- Call `context_pack` before broad file exploration.");
  lines.push("- Use returned citations as evidence refs for `write_lesson`.");
  lines.push("- Prefer `impact_analysis` before editing shared modules.");

  if (report.status.warnings.length > 0) {
    lines.push("", "## Warnings");
    for (const warning of report.status.warnings.slice(0, 20)) lines.push(`- ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderHtml(report: ContextReport): string {
  const markdown = renderMarkdown(report)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contextful Report</title>
  <style>
    body { font: 15px/1.55 system-ui, sans-serif; margin: 0; color: #141414; background: #f7f7f4; }
    main { max-width: 920px; margin: 0 auto; padding: 40px 24px; }
    pre { white-space: pre-wrap; background: #fff; border: 1px solid #deded8; border-radius: 8px; padding: 24px; }
  </style>
</head>
<body><main><pre>${markdown}</pre></main></body>
</html>
`;
}

export function packTokenCount(text: string): number {
  return estimateTokens(text);
}
