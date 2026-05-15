import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeKernelDb, count, getFileHashes, insertChunk, insertEdge, insertFile, insertSymbol, listMemories, openKernelDb, rebuildAdjacencyCache, resetIndex, setMemoryStatus, setMeta } from "./db.js";
import { discoverWorkspaceFiles } from "./files.js";
import { detectLanguage, isSupportedPrimaryLanguage } from "./language.js";
import { extractFileFacts } from "./extract.js";
import { probeTreeSitterBackend } from "./parser-backend.js";
import { type IndexResult, SCHEMA_VERSION } from "./types.js";
import { hashText, nowIso, resolveWorkspace, stateDirFor } from "./util.js";

const INDEX_LOCK_TIMEOUT_MS = 120_000;
const INDEX_LOCK_STALE_MS = 10 * 60_000;

export async function indexWorkspace(options: { workspace?: string }): Promise<IndexResult> {
  const workspace = resolveWorkspace(options.workspace);
  return withIndexLock(workspace, () => runIndexWorkspace(workspace));
}

async function runIndexWorkspace(workspace: string): Promise<IndexResult> {
  const kernel = openKernelDb(workspace);
  const db = kernel.db;
  const indexedAt = nowIso();
  const warnings: string[] = [];

  try {
    const oldHashes = getFileHashes(db);
    const discovery = await discoverWorkspaceFiles(workspace);
    warnings.push(...discovery.warnings);
    const parserBackend = await probeTreeSitterBackend();
    if (!parserBackend.ok) warnings.push(parserBackend.detail);

    const filePayloads = discovery.files.map((file) => {
      const content = fs.readFileSync(file.absolutePath, "utf8");
      return {
        ...file,
        content,
        hash: hashText(content),
        language: detectLanguage(file.relativePath)
      };
    });

    const newHashes = new Map(filePayloads.map((file) => [file.relativePath, file.hash]));
    const changedFiles = detectChangedFiles(oldHashes, newHashes);
    markMemoriesStaleForChangedFiles(db, changedFiles);

    resetIndex(db);
    const gitCommit = readGitCommit(workspace);

    const insertAll = db.transaction(() => {
      for (const file of filePayloads) {
        if (!isSupportedPrimaryLanguage(file.language)) {
          warnings.push(`Indexed ${file.relativePath} with text fallback parser.`);
        }
        insertFile(db, {
          path: file.relativePath,
          absolutePath: file.absolutePath,
          language: file.language,
          hash: file.hash,
          size: file.size,
          mtimeMs: file.mtimeMs,
          indexedAt,
          gitCommit
        });
        const facts = extractFileFacts({ relativePath: file.relativePath, content: file.content });
        for (const chunk of facts.chunks) insertChunk(db, chunk);
        for (const symbol of facts.symbols) insertSymbol(db, symbol);
        for (const edge of facts.edges) insertEdge(db, edge);
      }
      rebuildAdjacencyCache(db);
    });
    insertAll();

    setMeta(db, "schema_version", String(SCHEMA_VERSION));
    setMeta(db, "workspace", workspace);
    setMeta(db, "indexed_at", indexedAt);
    setMeta(db, "warnings", JSON.stringify(warnings.slice(-50)));
    setMeta(db, "parser_backend", `${parserBackend.detail}; deterministic extractors enabled`);

    return {
      workspace,
      stateDir: stateDirFor(workspace),
      dbPath: kernel.dbPath,
      indexedFiles: count(db, "files"),
      skippedFiles: discovery.skipped,
      chunks: count(db, "chunks"),
      symbols: count(db, "symbols"),
      edges: count(db, "edges"),
      changedFiles,
      warnings,
      indexedAt
    };
  } finally {
    closeKernelDb(kernel);
  }
}

async function withIndexLock(workspace: string, run: () => Promise<IndexResult>): Promise<IndexResult> {
  const stateDir = stateDirFor(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const release = await acquireIndexLock(path.join(stateDir, "index.lock"));
  try {
    return await run();
  } finally {
    release();
  }
}

async function acquireIndexLock(lockPath: string): Promise<() => void> {
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Best-effort cleanup. A stale lock is handled by the next indexer.
        }
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() - startedAt > INDEX_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Contextful index lock: ${lockPath}`);
      }
      await sleep(100);
    }
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > INDEX_LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
  } catch {
    // The lock disappeared between checks.
  }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectChangedFiles(oldHashes: Map<string, string>, newHashes: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [filePath, oldHash] of oldHashes.entries()) {
    const newHash = newHashes.get(filePath);
    if (!newHash || newHash !== oldHash) changed.add(filePath);
  }
  for (const filePath of newHashes.keys()) {
    if (!oldHashes.has(filePath)) changed.add(filePath);
  }
  return Array.from(changed).sort();
}

function markMemoriesStaleForChangedFiles(db: import("better-sqlite3").Database, changedFiles: string[]): void {
  if (changedFiles.length === 0) return;
  const changed = new Set(changedFiles);
  for (const memory of listMemories(db, "active")) {
    if (memory.evidenceRefs.some((ref) => evidenceTouchesChangedFile(ref, changed))) {
      setMemoryStatus(db, memory.id, "stale");
    }
  }
}

function evidenceTouchesChangedFile(ref: string, changed: Set<string>): boolean {
  if (ref.startsWith("file:")) {
    const withoutPrefix = ref.slice("file:".length);
    const filePath = withoutPrefix.replace(/:\d+-\d+$/, "");
    return changed.has(filePath);
  }
  if (ref.startsWith("symbol:")) {
    const withoutPrefix = ref.slice("symbol:".length);
    const filePath = withoutPrefix.split("#")[0];
    return changed.has(filePath);
  }
  return false;
}

function readGitCommit(workspace: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).trim();
  } catch {
    return undefined;
  }
}

export async function watchWorkspace(workspace: string, onIndex: (result: IndexResult) => void): Promise<void> {
  const resolved = path.resolve(workspace);
  onIndex(await indexWorkspace({ workspace: resolved }));
  let timer: NodeJS.Timeout | undefined;
  fs.watch(resolved, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      onIndex(await indexWorkspace({ workspace: resolved }));
    }, 500);
  });
}
