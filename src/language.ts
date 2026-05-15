import path from "node:path";

const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml"
};

export function detectLanguage(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return EXTENSIONS[path.extname(name)] || "text";
}

export function isSupportedPrimaryLanguage(language: string): boolean {
  return ["typescript", "javascript", "python", "go", "rust", "json", "markdown"].includes(language);
}
