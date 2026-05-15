import { closeKernelDb, insertMemory, openKernelDb } from "./db.js";
import { ensureIndexed, searchContext } from "./search.js";
import { type MemoryRecord, type SearchHit } from "./types.js";
import { nowIso, resolveWorkspace, shortHash } from "./util.js";

export interface WriteLessonOptions {
  workspace?: string;
  claim: string;
  evidenceRefs: string[];
  scope?: string;
  confidence?: number;
  supersedes?: string;
}

export async function writeLesson(options: WriteLessonOptions): Promise<MemoryRecord> {
  const workspace = resolveWorkspace(options.workspace);
  await ensureIndexed(workspace);
  const kernel = openKernelDb(workspace);
  try {
    const invalid = validateEvidenceRefs(kernel.db, options.evidenceRefs);
    if (invalid.length > 0) {
      throw new Error(`Invalid evidence refs: ${invalid.join(", ")}`);
    }
    const createdAt = nowIso();
    const memory: MemoryRecord = {
      id: `mem_${shortHash(`${options.claim}:${createdAt}`)}`,
      claim: options.claim,
      scope: options.scope || "repo",
      evidenceRefs: options.evidenceRefs,
      confidence: options.confidence ?? 0.7,
      status: "active",
      createdAt,
      lastVerified: createdAt,
      supersedes: options.supersedes
    };
    insertMemory(kernel.db, memory);
    return memory;
  } finally {
    closeKernelDb(kernel);
  }
}

export async function recallMemory(options: { workspace?: string; query: string; limit?: number }): Promise<SearchHit[]> {
  const result = await searchContext({ workspace: options.workspace, query: options.query, kind: "memory", limit: options.limit ?? 10 });
  return result.hits;
}

function validateEvidenceRefs(db: import("better-sqlite3").Database, refs: string[]): string[] {
  if (refs.length === 0) return ["<empty>"];
  const invalid: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("file:")) {
      const filePath = ref.slice("file:".length).replace(/:\d+-\d+$/, "");
      const row = db.prepare("SELECT path FROM files WHERE path = ?").get(filePath);
      if (!row) invalid.push(ref);
      continue;
    }
    if (ref.startsWith("symbol:")) {
      const row = db.prepare("SELECT ref FROM symbols WHERE ref = ?").get(ref);
      if (!row) invalid.push(ref);
      continue;
    }
    if (ref.startsWith("pack:")) {
      const id = ref.slice("pack:".length);
      const row = db.prepare("SELECT id FROM evidence_packs WHERE id = ?").get(id);
      if (!row) invalid.push(ref);
      continue;
    }
    invalid.push(ref);
  }
  return invalid;
}
