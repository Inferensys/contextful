import path from "node:path";
import { detectLanguage } from "./language.js";
import { type ChunkRecord, type ExtractedFacts, type GraphEdge, type SymbolRecord } from "./types.js";
import { estimateTokens, excerpt, lineRange } from "./util.js";

interface FileInput {
  relativePath: string;
  content: string;
}

interface RawSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
  exported?: boolean;
}

interface RawEdge {
  targetName: string;
  targetType: GraphEdge["targetType"];
  edgeType: GraphEdge["edgeType"];
  line: number;
}

export function extractFileFacts(input: FileInput): ExtractedFacts {
  const language = detectLanguage(input.relativePath);
  const symbols = extractSymbols(input.relativePath, input.content, language);
  const edges = extractEdges(input.relativePath, input.content, language);
  const chunks = buildChunks(input.relativePath, input.content, language, symbols);

  const symbolRecords = symbols.map((symbol) => ({
    ref: symbolRef(input.relativePath, symbol.name, symbol.line),
    name: symbol.name,
    kind: symbol.kind,
    filePath: input.relativePath,
    line: symbol.line,
    signature: symbol.signature,
    exported: Boolean(symbol.exported)
  }));

  const defineEdges: GraphEdge[] = symbolRecords.map((symbol) => ({
    sourceType: "file",
    sourceName: input.relativePath,
    targetType: "symbol",
    targetName: symbol.name,
    edgeType: "DEFINES",
    filePath: input.relativePath,
    line: symbol.line
  }));

  const graphEdges: GraphEdge[] = edges.map((edge) => ({
    sourceType: "file",
    sourceName: input.relativePath,
    targetType: edge.targetType,
    targetName: edge.targetName,
    edgeType: edge.edgeType,
    filePath: input.relativePath,
    line: edge.line
  }));

  if (isTestFile(input.relativePath)) {
    for (const edge of graphEdges.filter((item) => item.edgeType === "IMPORTS")) {
      graphEdges.push({ ...edge, edgeType: "TESTS" });
    }
  }

  return { chunks, symbols: symbolRecords, edges: [...defineEdges, ...graphEdges] };
}

function buildChunks(relativePath: string, content: string, language: string, symbols: RawSymbol[]): ChunkRecord[] {
  if (language === "markdown") return markdownChunks(relativePath, content);
  if (language === "json") return jsonChunks(relativePath, content);

  const lines = content.split(/\r?\n/);
  const chunks: ChunkRecord[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < symbols.length; index++) {
    const current = symbols[index];
    const next = symbols[index + 1];
    const endLine = Math.min(lines.length, next ? Math.max(current.line, next.line - 1) : current.line + 60);
    const text = lineRange(content, current.line, endLine);
    const ref = fileRef(relativePath, current.line, endLine);
    seen.add(ref);
    chunks.push({
      ref,
      filePath: relativePath,
      startLine: current.line,
      endLine,
      kind: "symbol",
      title: `${current.kind} ${current.name}`,
      text,
      tokenEstimate: estimateTokens(text)
    });
  }

  const windowSize = 80;
  for (let start = 1; start <= lines.length; start += windowSize) {
    const end = Math.min(lines.length, start + windowSize - 1);
    const ref = fileRef(relativePath, start, end);
    if (seen.has(ref)) continue;
    const text = lineRange(content, start, end);
    chunks.push({
      ref,
      filePath: relativePath,
      startLine: start,
      endLine: end,
      kind: "file",
      title: `${relativePath}:${start}-${end}`,
      text,
      tokenEstimate: estimateTokens(text)
    });
  }

  return chunks;
}

function markdownChunks(relativePath: string, content: string): ChunkRecord[] {
  const lines = content.split(/\r?\n/);
  const headings: Array<{ title: string; line: number }> = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) headings.push({ title: match[2].trim(), line: index + 1 });
  });
  if (headings.length === 0) {
    return [
      {
        ref: fileRef(relativePath, 1, Math.max(1, lines.length)),
        filePath: relativePath,
        startLine: 1,
        endLine: Math.max(1, lines.length),
        kind: "doc",
        title: relativePath,
        text: content,
        tokenEstimate: estimateTokens(content)
      }
    ];
  }
  return headings.map((heading, index) => {
    const next = headings[index + 1];
    const endLine = next ? next.line - 1 : lines.length;
    const text = lineRange(content, heading.line, endLine);
    return {
      ref: fileRef(relativePath, heading.line, endLine),
      filePath: relativePath,
      startLine: heading.line,
      endLine,
      kind: "doc",
      title: heading.title,
      text,
      tokenEstimate: estimateTokens(text)
    };
  });
}

function jsonChunks(relativePath: string, content: string): ChunkRecord[] {
  const lines = content.split(/\r?\n/);
  return [
    {
      ref: fileRef(relativePath, 1, Math.max(1, lines.length)),
      filePath: relativePath,
      startLine: 1,
      endLine: Math.max(1, lines.length),
      kind: "config",
      title: `${path.basename(relativePath)} config`,
      text: content,
      tokenEstimate: estimateTokens(content)
    }
  ];
}

function extractSymbols(relativePath: string, content: string, language: string): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const push = (name: string, kind: string, exported = false) =>
      symbols.push({ name, kind, line: lineNumber, signature: excerpt(line, 160), exported });

    if (language === "typescript" || language === "javascript") {
      matchPush(line, /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, push, "function");
      matchPush(line, /^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/, push, "class");
      matchPush(line, /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/, push, "interface");
      matchPush(line, /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)/, push, "type");
      matchPush(line, /^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, push, "function");
    } else if (language === "python") {
      const def = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/);
      if (def) push(def[1], "function");
      const cls = line.match(/^\s*class\s+([A-Za-z_][\w]*)/);
      if (cls) push(cls[1], "class");
    } else if (language === "go") {
      const fn = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/);
      if (fn) push(fn[1], "function", /^[A-Z]/.test(fn[1]));
      const typ = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+(struct|interface)/);
      if (typ) push(typ[1], typ[2], /^[A-Z]/.test(typ[1]));
    } else if (language === "rust") {
      matchPush(line, /^\s*(pub\s+)?fn\s+([A-Za-z_][\w]*)/, push, "function");
      matchPush(line, /^\s*(pub\s+)?struct\s+([A-Za-z_][\w]*)/, push, "struct");
      matchPush(line, /^\s*(pub\s+)?enum\s+([A-Za-z_][\w]*)/, push, "enum");
      matchPush(line, /^\s*(pub\s+)?trait\s+([A-Za-z_][\w]*)/, push, "trait");
      const impl = line.match(/^\s*impl(?:<[^>]+>)?\s+([A-Za-z_][\w]*)/);
      if (impl) push(impl[1], "impl");
    } else if (language === "markdown") {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) push(heading[2].trim(), "heading");
    } else if (language === "json") {
      for (const match of line.matchAll(/"([^"]+)"\s*:/g)) {
        if (match[1] && !match[1].includes(" ")) push(match[1], "config-key");
      }
    }
  });
  return symbols;
}

function matchPush(
  line: string,
  pattern: RegExp,
  push: (name: string, kind: string, exported?: boolean) => void,
  kind: string
): void {
  const match = line.match(pattern);
  if (!match) return;
  push(match[2], kind, Boolean(match[1]));
}

function extractEdges(relativePath: string, content: string, language: string): RawEdge[] {
  const edges: RawEdge[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const addImport = (targetName: string) =>
      edges.push({ targetName, targetType: "module", edgeType: "IMPORTS", line: lineNumber });

    if (language === "typescript" || language === "javascript") {
      for (const match of line.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)) addImport(match[1]);
      for (const match of line.matchAll(/require\(["']([^"']+)["']\)/g)) addImport(match[1]);
    } else if (language === "python") {
      const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+/);
      if (from) addImport(from[1]);
      const imp = line.match(/^\s*import\s+([\w.]+)/);
      if (imp) addImport(imp[1]);
    } else if (language === "go") {
      for (const match of line.matchAll(/"([^"]+)"/g)) addImport(match[1]);
    } else if (language === "rust") {
      const use = line.match(/^\s*use\s+([^;]+);/);
      if (use) addImport(use[1].trim());
      const mod = line.match(/^\s*mod\s+([A-Za-z_][\w]*);/);
      if (mod) addImport(mod[1]);
    } else if (language === "json") {
      const configMatch = line.match(/"([^"]+)"\s*:/);
      if (configMatch) {
        edges.push({
          targetName: configMatch[1],
          targetType: "config",
          edgeType: "CONFIGURES",
          line: lineNumber
        });
      }
    }
  });

  if (relativePath.endsWith("package.json")) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "scripts"]) {
        const values = parsed[section];
        if (!values || typeof values !== "object") continue;
        for (const key of Object.keys(values)) {
          edges.push({ targetName: `${section}:${key}`, targetType: "config", edgeType: "CONFIGURES", line: 1 });
        }
      }
    } catch {
      // Broken JSON still receives text chunks; syntax diagnostics are out of scope for v1.
    }
  }

  return edges;
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[A-Za-z0-9]+$/.test(relativePath);
}

function fileRef(relativePath: string, startLine: number, endLine: number): string {
  return `file:${relativePath}:${startLine}-${endLine}`;
}

function symbolRef(relativePath: string, name: string, line: number): string {
  return `symbol:${relativePath}#${name}:${line}`;
}
