import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./types.js";

const SECRET_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:sk|pk|ghp|gho|github_pat|xoxb|xoxp|AKIA)[A-Za-z0-9_\-]{12,}\b/g,
  /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+/gi
];

export function resolveWorkspace(workspace?: string): string {
  return path.resolve(workspace || process.cwd());
}

export function stateDirFor(workspace: string): string {
  return path.join(workspace, STATE_DIR);
}

export function dbPathFor(workspace: string): string {
  return path.join(stateDirFor(workspace), "context.sqlite");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativePath(workspace: string, absolutePath: string): string {
  return toPosixPath(path.relative(workspace, absolutePath));
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function shortHash(text: string): string {
  return hashText(text).slice(0, 12);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function excerpt(text: string, maxChars = 500): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function redactText(text: string, workspace?: string): string {
  let redacted = text;
  if (workspace) {
    redacted = redacted.split(workspace).join("<workspace>");
    const home = process.env.HOME;
    if (home) redacted = redacted.split(home).join("<home>");
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.includes("@") && !match.toLowerCase().includes("token")) return "<email>";
      const key = match.split(/[:=]/)[0]?.trim();
      return key && key.length < match.length ? `${key}=<redacted>` : "<secret>";
    });
  }
  return redacted;
}

export function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

export function lineRange(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
