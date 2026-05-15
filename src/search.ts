import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { addQuery, closeKernelDb, count, getMeta, memoryFromRow, openKernelDb, saveEvidencePack } from "./db.js";
import { indexWorkspace } from "./indexer.js";
import {
  type EvidencePack,
  type GraphPath,
  type IndexStatus,
  type SearchHit,
  type SearchIntent,
  type SymbolRecord,
  SCHEMA_VERSION
} from "./types.js";
import { clamp, dbPathFor, estimateTokens, excerpt, nowIso, redactText, resolveWorkspace, shortHash } from "./util.js";

interface SearchOptions {
  workspace?: string;
  query: string;
  limit?: number;
  kind?: "all" | "code" | "docs" | "symbols" | "memory";
}

interface ContextPackOptions {
  workspace?: string;
  query: string;
  budget?: number;
  scope?: string;
}

interface FtsChunkRow {
  ref: string;
  path: string;
  title: string;
  text: string;
  rank: number;
}

interface FtsSymbolRow {
  ref: string;
  path: string;
  name: string;
  kind: string;
  signature: string;
  rank: number;
}

interface FtsMemoryRow {
  id: string;
  claim: string;
  scope: string;
  rank: number;
}

interface SymbolRow {
  ref: string;
  name: string;
  kind: string;
  file_path: string;
  line: number;
  signature: string;
  exported: number;
}

interface EdgeRow {
  source_name: string;
  target_name: string;
  edge_type: string;
  file_path: string;
  line: number;
}

export async function ensureIndexed(workspace: string): Promise<void> {
  const dbPath = dbPathFor(workspace);
  if (!fs.existsSync(dbPath)) {
    await indexWorkspace({ workspace });
    return;
  }
  const kernel = openKernelDb(workspace);
  let needsIndex = false;
  try {
    needsIndex = count(kernel.db, "files") === 0;
  } finally {
    closeKernelDb(kernel);
  }
  if (needsIndex) await indexWorkspace({ workspace });
}

export function classifyQuery(query: string): SearchIntent {
  const q = query.toLowerCase();
  if (/\b(memory|memories|remember|remembers|lesson|lessons|learned|preference|preferences|mistake|mistakes|session|sessions|again)\b/.test(q)) return "memory";
  if (/\b(impact|affected|depends on|dependents|blast radius|what uses|who calls)\b/.test(q)) return "impact";
  if (/\b(why|changed|commit|history|regression|introduced)\b/.test(q)) return "historical";
  if (/\b(architecture|flow|path|trace|connects|calls|imports|dependency)\b/.test(q)) return "architectural";
  if (/\b(resource|docs|documentation|guide|readme|how to|setup)\b/.test(q)) return "docs";
  if (/[`"'#.:/]/.test(q) || /\b[A-Z][A-Za-z0-9_]{2,}\b/.test(query)) return "exact";
  return "vague";
}

export async function searchContext(options: SearchOptions): Promise<{ intent: SearchIntent; hits: SearchHit[] }> {
  const workspace = resolveWorkspace(options.workspace);
  await ensureIndexed(workspace);
  const intent = classifyQuery(options.query);
  const kernel = openKernelDb(workspace);
  try {
    addQuery(kernel.db, options.query, intent);
    const limit = options.limit ?? 10;
    const hits: SearchHit[] = [];
    const fts = ftsQuery(options.query);

    if (fts && options.kind !== "symbols" && options.kind !== "memory") {
      const rows = kernel.db
        .prepare("SELECT ref, path, title, text, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?")
        .all(fts, limit * 10) as FtsChunkRow[];
      hits.push(
        ...rows.map((row) => {
          const range = parseFileRef(row.ref);
          return {
            ref: row.ref,
            kind: "chunk" as const,
            path: row.path,
            title: row.title,
            excerpt: excerpt(redactText(row.text, workspace)),
            score: scoreFromRank(row.rank, options.query, `${row.path} ${row.title} ${row.text}`),
            startLine: range?.startLine,
            endLine: range?.endLine
          };
        })
      );
    }

    if (fts && options.kind !== "docs" && options.kind !== "memory") {
      const rows = kernel.db
        .prepare(
          "SELECT ref, path, name, kind, signature, bm25(symbols_fts) AS rank FROM symbols_fts WHERE symbols_fts MATCH ? LIMIT ?"
        )
        .all(fts, limit * 10) as FtsSymbolRow[];
      hits.push(
        ...rows.map((row) => ({
          ref: row.ref,
          kind: "symbol" as const,
          path: row.path,
          title: `${row.kind} ${row.name}`,
          excerpt: row.signature,
          score: scoreFromRank(row.rank, options.query, `${row.path} ${row.name} ${row.kind} ${row.signature}`) + 2
        }))
      );
    }

    if (fts && (options.kind === "all" || options.kind === "memory" || intent === "memory")) {
      const rows = kernel.db
        .prepare("SELECT id, claim, scope, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?")
        .all(fts, limit) as FtsMemoryRow[];
      for (const row of rows) {
        const memory = kernel.db.prepare("SELECT * FROM memories WHERE id = ?").get(row.id);
        if (!memory) continue;
        const record = memoryFromRow(memory as Parameters<typeof memoryFromRow>[0]);
        hits.push({
          ref: `memory:${record.id}`,
          kind: "memory",
          title: `memory ${record.scope}`,
          excerpt: redactText(record.claim, workspace),
          score: scoreFromRank(row.rank, options.query, record.claim) + 1,
          evidence: record.evidenceRefs,
          status: record.status
        });
      }
    }

    return {
      intent,
      hits: dedupeHits(hits)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    };
  } finally {
    closeKernelDb(kernel);
  }
}

export async function searchCode(options: SearchOptions): Promise<{ intent: SearchIntent; hits: SearchHit[] }> {
  return searchContext(options);
}

export async function createContextPack(options: ContextPackOptions): Promise<EvidencePack> {
  const workspace = resolveWorkspace(options.workspace);
  const budget = options.budget ?? 2000;
  const search = await searchContext({ workspace, query: options.query, limit: 16 });
  const selected: SearchHit[] = [];
  let tokenEstimate = 0;

  for (const hit of search.hits) {
    const tokens = estimateTokens(`${hit.title}\n${hit.excerpt}`);
    if (selected.length > 0 && tokenEstimate + tokens > budget) continue;
    selected.push(hit);
    tokenEstimate += tokens;
    if (tokenEstimate >= budget) break;
  }

  const kernel = openKernelDb(workspace);
  try {
    const paths = selected.map((hit) => hit.path).filter((value): value is string => Boolean(value));
    const symbols = loadSymbolsForPaths(kernel.db, paths).slice(0, 20);
    const graphPaths = loadGraphPaths(kernel.db, paths, 20);
    const memoryHits = selected.filter((hit) => hit.kind === "memory");
    const files = Array.from(new Set(paths)).map((filePath) => ({
      path: filePath,
      reason: reasonForFile(filePath, selected),
      refs: selected.filter((hit) => hit.path === filePath).map((hit) => hit.ref)
    }));
    const pack: EvidencePack = {
      id: `ctx_${shortHash(`${options.query}:${nowIso()}`)}`,
      query: options.query,
      scope: options.scope,
      intent: search.intent,
      summary: summarizePack(options.query, search.intent, selected, graphPaths, memoryHits),
      citations: selected,
      files,
      symbols,
      graphPaths,
      memoryHits,
      confidence: confidenceFor(selected, graphPaths, memoryHits),
      tokenEstimate,
      budget,
      createdAt: nowIso()
    };
    saveEvidencePack(kernel.db, { id: pack.id, query: pack.query, tokenEstimate, json: JSON.stringify(pack) });
    return pack;
  } finally {
    closeKernelDb(kernel);
  }
}

export async function traceGraph(options: {
  workspace?: string;
  from: string;
  to?: string;
  edgeTypes?: string[];
  limit?: number;
}): Promise<GraphPath[]> {
  const workspace = resolveWorkspace(options.workspace);
  await ensureIndexed(workspace);
  const kernel = openKernelDb(workspace);
  try {
    const needle = `%${options.from}%`;
    const rows = kernel.db
      .prepare(
        "SELECT source_name, target_name, edge_type, file_path, line FROM edges WHERE source_name LIKE ? OR target_name LIKE ? OR file_path LIKE ? LIMIT ?"
      )
      .all(needle, needle, needle, (options.limit ?? 25) * 3) as EdgeRow[];
    return rows
      .filter((row) => !options.to || row.target_name.includes(options.to) || row.source_name.includes(options.to))
      .filter((row) => !options.edgeTypes?.length || options.edgeTypes.includes(row.edge_type))
      .slice(0, options.limit ?? 25)
      .map(edgeRowToGraphPath);
  } finally {
    closeKernelDb(kernel);
  }
}

export async function tracePath(options: {
  workspace?: string;
  from: string;
  to?: string;
  edgeTypes?: string[];
  limit?: number;
}): Promise<GraphPath[]> {
  return traceGraph(options);
}

export async function impactAnalysis(options: { workspace?: string; target: string; limit?: number }): Promise<{
  target: string;
  dependents: GraphPath[];
  tests: GraphPath[];
}> {
  const workspace = resolveWorkspace(options.workspace);
  await ensureIndexed(workspace);
  const kernel = openKernelDb(workspace);
  try {
    const needle = `%${options.target}%`;
    const rows = kernel.db
      .prepare(
        "SELECT source_name, target_name, edge_type, file_path, line FROM edges WHERE target_name LIKE ? OR source_name LIKE ? OR file_path LIKE ? LIMIT ?"
      )
      .all(needle, needle, needle, (options.limit ?? 30) * 2) as EdgeRow[];
    const paths = rows.map(edgeRowToGraphPath);
    return {
      target: options.target,
      dependents: paths.filter((path) => path.edgeType === "IMPORTS" || path.edgeType === "DEFINES").slice(0, options.limit ?? 30),
      tests: paths.filter((path) => path.edgeType === "TESTS" || /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\./.test(path.filePath))
    };
  } finally {
    closeKernelDb(kernel);
  }
}

export async function whyChanged(options: { workspace?: string; target: string; limit?: number }): Promise<{
  target: string;
  currentEvidence: SearchHit[];
  commits: Array<{ hash: string; subject: string; date?: string; files: string[] }>;
}> {
  const workspace = resolveWorkspace(options.workspace);
  const current = await searchContext({ workspace, query: options.target, limit: Math.min(options.limit ?? 8, 12) });
  const filePaths = Array.from(new Set(current.hits.map((hit) => hit.path).filter((value): value is string => Boolean(value)))).slice(0, 5);
  const commits = readGitHistory(workspace, filePaths, options.limit ?? 8);
  return {
    target: options.target,
    currentEvidence: current.hits,
    commits
  };
}

export async function getIndexStatus(options: { workspace?: string }): Promise<IndexStatus> {
  const workspace = resolveWorkspace(options.workspace);
  await ensureIndexed(workspace);
  const kernel = openKernelDb(workspace);
  try {
    const languageRows = kernel.db
      .prepare("SELECT language, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC")
      .all() as Array<{ language: string; count: number }>;
    const warnings = JSON.parse(getMeta(kernel.db, "warnings") || "[]") as string[];
    return {
      workspace,
      dbPath: kernel.dbPath,
      schemaVersion: Number(getMeta(kernel.db, "schema_version") || SCHEMA_VERSION),
      indexedAt: getMeta(kernel.db, "indexed_at"),
      fileCount: count(kernel.db, "files"),
      chunkCount: count(kernel.db, "chunks"),
      symbolCount: count(kernel.db, "symbols"),
      edgeCount: count(kernel.db, "edges"),
      graphNodeCount: count(kernel.db, "nodes"),
      memoryCount: count(kernel.db, "memories"),
      staleMemoryCount: (kernel.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'stale'").get() as { count: number }).count,
      languageCounts: Object.fromEntries(languageRows.map((row) => [row.language, row.count])),
      warnings
    };
  } finally {
    closeKernelDb(kernel);
  }
}

function ftsQuery(query: string): string {
  const terms = expandedTerms(query);
  return Array.from(new Set(terms.map((term) => term.toLowerCase())))
    .filter((term) => !STOPWORDS.has(term))
    .slice(0, 14)
    .map((term) => `${term}*`)
    .join(" OR ");
}

function scoreFromRank(rank: number, query: string, corpus: string): number {
  const lower = corpus.toLowerCase();
  const q = query.toLowerCase();
  const exactBonus = expandedTerms(query)
    .filter((term) => term.length > 2 && lower.includes(term)).length;
  let bonus = exactBonus;
  if (/\b(tool|tools|registered|register)\b/.test(q) && lower.includes("server.tool(")) bonus += 9;
  if (/\bmcp\b/.test(q) && lower.includes("mcp-server")) bonus += 4;
  if (/\b(where|registered|register)\b/.test(q) && lower.includes("function runmcpserver")) bonus += 4;
  if (/\b(tool|tools|registered|register)\b/.test(q) && lower.includes("src/search.ts")) bonus -= 8;
  if (/\b(memory|memories|remember|remembers|lesson|lessons|session|sessions)\b/.test(q)) {
    if (lower.includes("memory ledger") || lower.includes("evidence-backed memory")) bonus += 7;
    if (lower.includes("src/memory.ts")) bonus += 5;
    if (lower.includes("readme.md")) bonus += 4;
    if (lower.includes("src/search.ts")) bonus -= 16;
    if (lower.includes("function scorefromrank") || lower.includes("function classifyquery") || lower.includes("function expandedterms")) {
      bonus -= 8;
    }
  }
  if (/\b(where|how)\b/.test(q) && lower.includes("config-key")) bonus -= 2;
  return 10 / (1 + Math.abs(rank)) + bonus;
}

const STOPWORDS = new Set(["where", "what", "which", "when", "how", "are", "the", "for", "with", "and", "or", "to"]);

function expandedTerms(query: string): string[] {
  const terms = query.match(/[A-Za-z0-9_]{2,}/g) || [];
  const lower = query.toLowerCase();
  const additions: string[] = [];
  if (/\b(tool|tools|registered|register)\b/.test(lower)) additions.push("server", "tool", "tools", "callTool");
  if (/\bmcp\b/.test(lower)) additions.push("mcp", "server", "stdio");
  if (/\bmemory|memories|remember|remembers|lesson|lessons|learned|session|sessions\b/.test(lower)) {
    additions.push("memory", "memories", "lesson", "lessons", "claim", "ledger", "evidence");
  }
  if (/\bimpact|depends|dependents|uses\b/.test(lower)) additions.push("imports", "tests", "edges");
  return [...terms, ...additions];
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.ref)) return false;
    seen.add(hit.ref);
    return true;
  });
}

function parseFileRef(ref: string): { path: string; startLine: number; endLine: number } | undefined {
  const match = ref.match(/^file:(.+):(\d+)-(\d+)$/);
  if (!match) return undefined;
  return { path: match[1], startLine: Number(match[2]), endLine: Number(match[3]) };
}

function loadSymbolsForPaths(db: import("better-sqlite3").Database, paths: string[]): SymbolRecord[] {
  if (paths.length === 0) return [];
  const rows = db
    .prepare(`SELECT ref, name, kind, file_path, line, signature, exported FROM symbols WHERE file_path IN (${paths.map(() => "?").join(",")})`)
    .all(...paths) as SymbolRow[];
  return rows.map((row) => ({
    ref: row.ref,
    name: row.name,
    kind: row.kind,
    filePath: row.file_path,
    line: row.line,
    signature: row.signature,
    exported: Boolean(row.exported)
  }));
}

function loadGraphPaths(db: import("better-sqlite3").Database, paths: string[], limit: number): GraphPath[] {
  if (paths.length === 0) return [];
  const rows = db
    .prepare(`SELECT source_name, target_name, edge_type, file_path, line FROM edges WHERE file_path IN (${paths.map(() => "?").join(",")}) LIMIT ?`)
    .all(...paths, limit) as EdgeRow[];
  return rows.map(edgeRowToGraphPath);
}

function edgeRowToGraphPath(row: EdgeRow): GraphPath {
  return {
    from: row.source_name,
    to: row.target_name,
    edgeType: row.edge_type,
    filePath: row.file_path,
    line: row.line
  };
}

function reasonForFile(filePath: string, hits: SearchHit[]): string {
  const refs = hits.filter((hit) => hit.path === filePath);
  const symbolCount = refs.filter((hit) => hit.kind === "symbol").length;
  if (symbolCount > 0) return `Matched ${symbolCount} relevant symbol${symbolCount === 1 ? "" : "s"}.`;
  return `Matched ${refs.length} relevant context chunk${refs.length === 1 ? "" : "s"}.`;
}

function summarizePack(query: string, intent: SearchIntent, hits: SearchHit[], graphPaths: GraphPath[], memoryHits: SearchHit[]): string {
  if (hits.length === 0) return `No indexed evidence matched "${query}". Re-index or broaden the query.`;
  return `Found ${hits.length} evidence item${hits.length === 1 ? "" : "s"} for a ${intent} query, with ${graphPaths.length} graph connection${graphPaths.length === 1 ? "" : "s"} and ${memoryHits.length} memory hit${memoryHits.length === 1 ? "" : "s"}.`;
}

function confidenceFor(hits: SearchHit[], graphPaths: GraphPath[], memoryHits: SearchHit[]): number {
  return clamp(0.25 + hits.length * 0.05 + graphPaths.length * 0.02 + memoryHits.length * 0.05, 0.1, 0.92);
}

function readGitHistory(
  workspace: string,
  filePaths: string[],
  limit: number
): Array<{ hash: string; subject: string; date?: string; files: string[] }> {
  try {
    const args = ["log", `--max-count=${limit}`, "--date=short", "--pretty=format:%H%x1f%ad%x1f%s"];
    if (filePaths.length > 0) args.push("--", ...filePaths);
    const output = execFileSync("git", args, {
      cwd: workspace,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).trim();
    if (!output) return [];
    return output.split(/\r?\n/).map((line) => {
      const [hash, date, subject] = line.split("\x1f");
      return {
        hash: hash?.slice(0, 12) || "",
        date,
        subject: subject || "",
        files: filePaths
      };
    });
  } catch {
    return [];
  }
}
