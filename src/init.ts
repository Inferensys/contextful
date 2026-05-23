import fs from "node:fs";
import path from "node:path";
import { indexWorkspace } from "./indexer.js";
import { type IndexResult } from "./types.js";
import { relativePath, resolveWorkspace, stateDirFor } from "./util.js";

export interface InitResult {
  workspace: string;
  stateDir: string;
  instructionsPath: string;
  index: IndexResult;
  nextSteps: string[];
}

export async function initWorkspace(options: { workspace?: string }): Promise<InitResult> {
  const workspace = resolveWorkspace(options.workspace);
  const index = await indexWorkspace({ workspace });
  const stateDir = stateDirFor(workspace);
  const instructionsPath = path.join(stateDir, "AGENT_INSTRUCTIONS.md");
  fs.writeFileSync(instructionsPath, renderAgentInstructions(workspace), "utf8");

  return {
    workspace,
    stateDir,
    instructionsPath,
    index,
    nextSteps: [
      'Run `cxf search "where is auth handled?" --workspace .` to test retrieval.',
      "Add `npx -y @inferensys/contextful server` to your MCP client config.",
      "Tell the agent to call `context_pack` before broad file reads."
    ]
  };
}

export function renderInitSummary(result: InitResult): string {
  const instructions = relativePath(result.workspace, result.instructionsPath);
  return [
    "Contextful initialized",
    "",
    `Workspace: ${result.workspace}`,
    `State: ${relativePath(result.workspace, result.stateDir)}`,
    `Agent instructions: ${instructions}`,
    `Indexed files: ${result.index.indexedFiles}`,
    `Chunks: ${result.index.chunks}`,
    `Symbols: ${result.index.symbols}`,
    `Graph edges: ${result.index.edges}`,
    "",
    "Next steps:",
    ...result.nextSteps.map((step) => `- ${step}`),
    ""
  ].join("\n");
}

function renderAgentInstructions(workspace: string): string {
  return `# Contextful Agent Instructions

Workspace: ${workspace}

Use Contextful as the first retrieval layer for this project. The goal is to avoid broad file-reading loops and return cited, token-budgeted evidence before making code changes.

## Default Rule

Before running broad grep/glob/read-file exploration, call:

\`\`\`text
context_pack(query, budget, scope)
\`\`\`

Use a budget between 800 and 3000 tokens for normal tasks. Use a higher budget only when the user asks for a deep architecture pass.

## When To Use Contextful

- Vague project questions: "where is auth handled", "resources for billing webhooks", "how does onboarding state work".
- Architecture questions: flows, dependencies, config paths, module relationships, or tests.
- Impact questions before editing shared code.
- Memory questions where prior session learnings might matter.
- Any task where you are about to read more than 3 files to gather context.

## Tool Preference

1. \`context_pack\` for most questions.
2. \`search_code\` for narrow exact lookup after the pack.
3. \`trace_path\` or \`impact_analysis\` when relationships matter.
4. \`recall_memory\` before repeating known project work.
5. \`write_lesson\` only when the lesson has valid evidence refs.

## Evidence Rules

- Treat citations from Contextful as the source of truth for follow-up reads.
- If a claim will affect code, verify it against the cited files before editing.
- Do not write memory without evidence refs from files, symbols, commits, or prior context packs.
- If evidence changes or appears stale, prefer fresh search over old memory.

## Local CLI For Humans

\`\`\`bash
cxf index --workspace .
cxf search "where is auth handled" --workspace . --budget 2000
cxf memory add --workspace . --claim "..." --evidence file:src/example.ts:1-20
cxf server
\`\`\`
`;
}
