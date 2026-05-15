export const SCHEMA_VERSION = 1;
export const STATE_DIR = ".contextful";

export type ReportFormat = "markdown" | "json" | "html";
export type SearchIntent = "exact" | "vague" | "architectural" | "impact" | "historical" | "docs" | "memory";
export type SearchKind = "chunk" | "symbol" | "memory";
export type MemoryStatus = "active" | "stale" | "superseded";

export interface DiscoveredFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export interface IndexedFile {
  path: string;
  absolutePath: string;
  language: string;
  hash: string;
  size: number;
  mtimeMs: number;
  indexedAt: string;
  gitCommit?: string;
}

export interface ChunkRecord {
  ref: string;
  filePath: string;
  startLine: number;
  endLine: number;
  kind: "file" | "symbol" | "doc" | "config";
  title: string;
  text: string;
  tokenEstimate: number;
}

export interface SymbolRecord {
  ref: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  signature: string;
  exported: boolean;
}

export interface GraphEdge {
  sourceType: "file" | "symbol";
  sourceName: string;
  targetType: "file" | "symbol" | "module" | "config";
  targetName: string;
  edgeType: "IMPORTS" | "DEFINES" | "CONFIGURES" | "TESTS" | "MENTIONS";
  filePath: string;
  line: number;
}

export interface ExtractedFacts {
  chunks: ChunkRecord[];
  symbols: SymbolRecord[];
  edges: GraphEdge[];
}

export interface SearchHit {
  ref: string;
  kind: SearchKind;
  path?: string;
  title: string;
  excerpt: string;
  score: number;
  startLine?: number;
  endLine?: number;
  evidence?: string[];
  status?: MemoryStatus;
}

export interface GraphPath {
  from: string;
  to: string;
  edgeType: string;
  filePath: string;
  line: number;
}

export interface MemoryRecord {
  id: string;
  claim: string;
  scope: string;
  evidenceRefs: string[];
  confidence: number;
  status: MemoryStatus;
  createdAt: string;
  lastVerified: string;
  supersedes?: string;
}

export interface EvidencePack {
  id: string;
  query: string;
  scope?: string;
  intent: SearchIntent;
  summary: string;
  citations: SearchHit[];
  files: Array<{ path: string; reason: string; refs: string[] }>;
  symbols: SymbolRecord[];
  graphPaths: GraphPath[];
  memoryHits: SearchHit[];
  confidence: number;
  tokenEstimate: number;
  budget: number;
  createdAt: string;
}

export interface IndexResult {
  workspace: string;
  stateDir: string;
  dbPath: string;
  indexedFiles: number;
  skippedFiles: number;
  chunks: number;
  symbols: number;
  edges: number;
  changedFiles: string[];
  warnings: string[];
  indexedAt: string;
}

export interface IndexStatus {
  workspace: string;
  dbPath: string;
  schemaVersion: number;
  indexedAt?: string;
  fileCount: number;
  chunkCount: number;
  symbolCount: number;
  edgeCount: number;
  graphNodeCount: number;
  memoryCount: number;
  staleMemoryCount: number;
  languageCounts: Record<string, number>;
  warnings: string[];
}

export interface ContextReport {
  status: IndexStatus;
  topQueries: Array<{ query: string; count: number; intent: SearchIntent }>;
  staleMemories: MemoryRecord[];
  recentPacks: Array<{ id: string; query: string; createdAt: string; tokenEstimate: number }>;
  tokenSavingsEstimate: {
    indexedTokens: number;
    averagePackTokens: number;
    estimatedSavingsRatio: number;
    estimatedToolCallsSaved: number;
    estimatedTimeSavedSeconds: number;
  };
}
