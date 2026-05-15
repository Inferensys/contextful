import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);
let probePromise: Promise<ParserBackendStatus> | undefined;

export interface ParserBackendStatus {
  ok: boolean;
  detail: string;
}

export function probeTreeSitterBackend(): Promise<ParserBackendStatus> {
  probePromise ??= runProbe();
  return probePromise;
}

async function runProbe(): Promise<ParserBackendStatus> {
  try {
    const runtimeWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
    await Parser.init({
      locateFile() {
        return runtimeWasm;
      }
    });
    const languagePath = require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm");
    const language = await Parser.Language.load(languagePath);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse("export function contextKernelProbe() { return true; }");
    if (!tree) {
      parser.delete();
      return { ok: false, detail: "web-tree-sitter runtime loaded, but probe parse returned no tree" };
    }
    const ok = !tree.rootNode.hasError();
    tree.delete();
    parser.delete();
    return {
      ok,
      detail: ok
        ? "web-tree-sitter runtime and tree-sitter-wasms TypeScript grammar are available"
        : "web-tree-sitter runtime loaded, but probe parse reported syntax errors"
    };
  } catch (error) {
    return {
      ok: false,
      detail: `tree-sitter WASM probe failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
