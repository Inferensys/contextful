import Database from "better-sqlite3";
import { dbPathFor, ensureDir, hashText, nowIso, stateDirFor } from "./util.js";
import {
  type ChunkRecord,
  type GraphEdge,
  type IndexedFile,
  type MemoryRecord,
  type SearchIntent,
  SCHEMA_VERSION
} from "./types.js";

export interface KernelDb {
  db: Database.Database;
  workspace: string;
  stateDir: string;
  dbPath: string;
}

interface CountRow {
  count: number;
}

interface MemoryRow {
  id: string;
  claim: string;
  scope: string;
  evidence_refs: string;
  confidence: number;
  status: "active" | "stale" | "superseded";
  created_at: string;
  last_verified: string;
  supersedes?: string | null;
}

export function openKernelDb(workspace: string): KernelDb {
  const stateDir = stateDirFor(workspace);
  ensureDir(stateDir);
  const dbPath = dbPathFor(workspace);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return { db, workspace, stateDir, dbPath };
}

export function closeKernelDb(kernel: KernelDb): void {
  kernel.db.close();
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      absolute_path TEXT NOT NULL,
      language TEXT NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      indexed_at TEXT NOT NULL,
      git_commit TEXT
    );

    CREATE TABLE IF NOT EXISTS chunks (
      ref TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS symbols (
      ref TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      signature TEXT NOT NULL,
      exported INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_name TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_props (
      node_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (node_id, key)
    );

    CREATE TABLE IF NOT EXISTS edge_props (
      edge_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (edge_id, key)
    );

    CREATE TABLE IF NOT EXISTS adjacency_cache (
      edge_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (edge_type, source_name)
    );

    CREATE TABLE IF NOT EXISTS fingerprints (
      ref TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      features_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vectors (
      ref TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      scope TEXT NOT NULL,
      evidence_refs TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_verified TEXT NOT NULL,
      supersedes TEXT
    );

    CREATE TABLE IF NOT EXISTS evidence_packs (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      content_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      intent TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(ref UNINDEXED, path, title, text);
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(ref UNINDEXED, path, name, kind, signature);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, claim, scope);
  `);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
}

export function resetIndex(db: Database.Database): void {
  db.exec(`
    DELETE FROM files;
    DELETE FROM chunks;
    DELETE FROM symbols;
    DELETE FROM edges;
    DELETE FROM nodes;
    DELETE FROM node_props;
    DELETE FROM edge_props;
    DELETE FROM adjacency_cache;
    DELETE FROM fingerprints;
    DELETE FROM vectors;
    DELETE FROM chunks_fts;
    DELETE FROM symbols_fts;
  `);
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value
  );
}

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function insertFile(db: Database.Database, file: IndexedFile): void {
  db.prepare(`
    INSERT INTO files (path, absolute_path, language, hash, size, mtime_ms, indexed_at, git_commit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(file.path, file.absolutePath, file.language, file.hash, file.size, file.mtimeMs, file.indexedAt, file.gitCommit);
  upsertNode(db, "file", file.path, {
    absolute_path: file.absolutePath,
    language: file.language,
    hash: file.hash,
    size: String(file.size)
  });
}

export function insertChunk(db: Database.Database, chunk: ChunkRecord): void {
  db.prepare(`
    INSERT INTO chunks (ref, file_path, start_line, end_line, kind, title, text, token_estimate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk.ref,
    chunk.filePath,
    chunk.startLine,
    chunk.endLine,
    chunk.kind,
    chunk.title,
    chunk.text,
    chunk.tokenEstimate
  );
  db.prepare("INSERT INTO chunks_fts (ref, path, title, text) VALUES (?, ?, ?, ?)").run(
    chunk.ref,
    chunk.filePath,
    chunk.title,
    chunk.text
  );
  upsertNode(db, "chunk", chunk.ref, {
    file_path: chunk.filePath,
    kind: chunk.kind,
    title: chunk.title,
    start_line: String(chunk.startLine),
    end_line: String(chunk.endLine)
  });
  insertFingerprint(db, chunk.ref, chunk.kind, `${chunk.title}\n${chunk.text}`);
}

export function insertSymbol(db: Database.Database, symbol: import("./types.js").SymbolRecord): void {
  db.prepare(`
    INSERT INTO symbols (ref, name, kind, file_path, line, signature, exported)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol.ref,
    symbol.name,
    symbol.kind,
    symbol.filePath,
    symbol.line,
    symbol.signature,
    symbol.exported ? 1 : 0
  );
  db.prepare("INSERT INTO symbols_fts (ref, path, name, kind, signature) VALUES (?, ?, ?, ?, ?)").run(
    symbol.ref,
    symbol.filePath,
    symbol.name,
    symbol.kind,
    symbol.signature
  );
  upsertNode(db, "symbol", symbol.ref, {
    name: symbol.name,
    kind: symbol.kind,
    file_path: symbol.filePath,
    line: String(symbol.line),
    exported: String(symbol.exported)
  });
  insertFingerprint(db, symbol.ref, "symbol", `${symbol.kind} ${symbol.name} ${symbol.signature}`);
}

export function insertEdge(db: Database.Database, edge: GraphEdge): number {
  upsertNode(db, edge.sourceType, edge.sourceName, {});
  upsertNode(db, edge.targetType, edge.targetName, {});
  const result = db.prepare(`
    INSERT INTO edges (source_type, source_name, target_type, target_name, edge_type, file_path, line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(edge.sourceType, edge.sourceName, edge.targetType, edge.targetName, edge.edgeType, edge.filePath, edge.line);
  const edgeId = Number(result.lastInsertRowid);
  insertEdgeProp(db, edgeId, "file_path", edge.filePath);
  insertEdgeProp(db, edgeId, "line", String(edge.line));
  return edgeId;
}

export function rebuildAdjacencyCache(db: Database.Database): void {
  db.prepare("DELETE FROM adjacency_cache").run();
  const rows = db
    .prepare("SELECT edge_type, source_name, target_name FROM edges ORDER BY edge_type, source_name, target_name")
    .all() as Array<{ edge_type: string; source_name: string; target_name: string }>;
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.edge_type}\x1f${row.source_name}`;
    const targets = grouped.get(key) || new Set<string>();
    targets.add(row.target_name);
    grouped.set(key, targets);
  }
  const insert = db.prepare(
    "INSERT INTO adjacency_cache (edge_type, source_name, targets_json, updated_at) VALUES (?, ?, ?, ?)"
  );
  for (const [key, targets] of grouped.entries()) {
    const [edgeType, sourceName] = key.split("\x1f");
    insert.run(edgeType, sourceName, JSON.stringify(Array.from(targets)), nowIso());
  }
}

export function addQuery(db: Database.Database, query: string, intent: SearchIntent): void {
  db.prepare("INSERT INTO queries (query, intent, created_at) VALUES (?, ?, ?)").run(query, intent, nowIso());
}

export function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
  return row.count;
}

export function getFileHashes(db: Database.Database): Map<string, string> {
  const rows = db.prepare("SELECT path, hash FROM files").all() as Array<{ path: string; hash: string }>;
  return new Map(rows.map((row) => [row.path, row.hash]));
}

export function listMemories(db: Database.Database, status?: string): MemoryRecord[] {
  const rows = (status
    ? db.prepare("SELECT * FROM memories WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM memories ORDER BY created_at DESC").all()) as MemoryRow[];
  return rows.map(memoryFromRow);
}

export function insertMemory(db: Database.Database, memory: MemoryRecord): void {
  db.prepare(`
    INSERT INTO memories (id, claim, scope, evidence_refs, confidence, status, created_at, last_verified, supersedes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.claim,
    memory.scope,
    JSON.stringify(memory.evidenceRefs),
    memory.confidence,
    memory.status,
    memory.createdAt,
    memory.lastVerified,
    memory.supersedes
  );
  db.prepare("INSERT INTO memories_fts (id, claim, scope) VALUES (?, ?, ?)").run(memory.id, memory.claim, memory.scope);
}

export function setMemoryStatus(db: Database.Database, id: string, status: MemoryRecord["status"]): void {
  db.prepare("UPDATE memories SET status = ?, last_verified = ? WHERE id = ?").run(status, nowIso(), id);
}

export function saveEvidencePack(db: Database.Database, pack: { id: string; query: string; tokenEstimate: number; json: string }): void {
  db.prepare(`
    INSERT INTO evidence_packs (id, query, created_at, token_estimate, content_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(pack.id, pack.query, nowIso(), pack.tokenEstimate, pack.json);
}

export function memoryFromRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    claim: row.claim,
    scope: row.scope,
    evidenceRefs: JSON.parse(row.evidence_refs) as string[],
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    lastVerified: row.last_verified,
    supersedes: row.supersedes || undefined
  };
}

function upsertNode(db: Database.Database, nodeType: string, name: string, props: Record<string, string>): void {
  const id = `${nodeType}:${name}`;
  db.prepare("INSERT INTO nodes (id, node_type, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET node_type = excluded.node_type, name = excluded.name").run(
    id,
    nodeType,
    name
  );
  for (const [key, value] of Object.entries(props)) insertNodeProp(db, id, key, value);
}

function insertNodeProp(db: Database.Database, nodeId: string, key: string, value: string): void {
  db.prepare(
    "INSERT INTO node_props (node_id, key, value) VALUES (?, ?, ?) ON CONFLICT(node_id, key) DO UPDATE SET value = excluded.value"
  ).run(nodeId, key, value);
}

function insertEdgeProp(db: Database.Database, edgeId: number, key: string, value: string): void {
  db.prepare(
    "INSERT INTO edge_props (edge_id, key, value) VALUES (?, ?, ?) ON CONFLICT(edge_id, key) DO UPDATE SET value = excluded.value"
  ).run(edgeId, key, value);
}

function insertFingerprint(db: Database.Database, ref: string, kind: string, text: string): void {
  const features = Array.from(
    new Set((text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map((term) => term.toLowerCase()).slice(0, 64))
  );
  const fingerprint = hashText(features.join("|")).slice(0, 24);
  db.prepare(
    "INSERT INTO fingerprints (ref, kind, fingerprint, features_json) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, fingerprint = excluded.fingerprint, features_json = excluded.features_json"
  ).run(ref, kind, fingerprint, JSON.stringify(features));
}
