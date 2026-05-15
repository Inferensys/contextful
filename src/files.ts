import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { type DiscoveredFile } from "./types.js";
import { isLikelyBinary } from "./util.js";

export interface DiscoveryResult {
  files: DiscoveredFile[];
  skipped: number;
  warnings: string[];
}

const DEFAULT_IGNORES = [
  ".git/**",
  ".contextful/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  ".turbo/**",
  ".cache/**",
  "vendor/**",
  "target/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.ico",
  "**/*.pdf",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.sqlite",
  "**/*.db"
];

const MAX_FILE_BYTES = 512 * 1024;

export async function discoverWorkspaceFiles(workspace: string): Promise<DiscoveryResult> {
  const ig = ignore().add(DEFAULT_IGNORES);
  const globIgnores = [...DEFAULT_IGNORES];
  const gitignorePath = path.join(workspace, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, "utf8");
    ig.add(gitignore);
    globIgnores.push(...gitignorePatterns(gitignore));
  }

  const entries = await fg("**/*", {
    cwd: workspace,
    dot: true,
    ignore: globIgnores,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true
  });

  const files: DiscoveredFile[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (const entry of entries.sort()) {
    const relativePath = entry.split(path.sep).join("/");
    if (ig.ignores(relativePath)) {
      skipped++;
      continue;
    }
    const absolutePath = path.join(workspace, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      skipped++;
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      skipped++;
      if (stat.size > MAX_FILE_BYTES) warnings.push(`Skipped large file: ${relativePath}`);
      continue;
    }
    const head = fs.readFileSync(absolutePath).subarray(0, 4096);
    if (isLikelyBinary(head)) {
      skipped++;
      continue;
    }
    files.push({
      relativePath,
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }

  return { files, skipped, warnings };
}

function gitignorePatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
}
