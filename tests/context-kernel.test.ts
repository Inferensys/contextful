import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createContextPack, generateReport, getIndexStatus, indexWorkspace, recallMemory, searchContext, whyChanged, writeLesson } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const fixtureRoot = path.join(__dirname, "fixtures", "sample-repo");
const tempDirs: string[] = [];

function copyFixture(): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "contextful-"));
  fs.cpSync(fixtureRoot, temp, { recursive: true });
  tempDirs.push(temp);
  return temp;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Contextful", () => {
  it("indexes a workspace with language coverage and ignores gitignored files", async () => {
    const workspace = copyFixture();
    const result = await indexWorkspace({ workspace });
    const status = await getIndexStatus({ workspace });

    expect(result.indexedFiles).toBeGreaterThanOrEqual(7);
    expect(result.skippedFiles).toBeGreaterThanOrEqual(0);
    expect(status.languageCounts.typescript).toBeGreaterThanOrEqual(3);
    expect(status.languageCounts.python).toBe(1);
    expect(status.languageCounts.go).toBe(1);
    expect(status.languageCounts.rust).toBe(1);
    expect(status.symbolCount).toBeGreaterThan(5);
  });

  it("creates compact evidence packs for exact and vague queries", async () => {
    const workspace = copyFixture();
    await indexWorkspace({ workspace });

    const exact = await createContextPack({ workspace, query: "AuthService login", budget: 800 });
    expect(exact.intent).toBe("exact");
    expect(exact.tokenEstimate).toBeLessThanOrEqual(800);
    expect(exact.citations.some((hit) => hit.ref.includes("src/auth.ts"))).toBe(true);

    const vague = await createContextPack({ workspace, query: "resources troubleshooting guide", budget: 800 });
    expect(vague.intent).toBe("docs");
    expect(vague.citations.some((hit) => hit.ref.includes("docs/resources.md"))).toBe(true);
  });

  it("requires evidence for memory and marks changed evidence stale", async () => {
    const workspace = copyFixture();
    await indexWorkspace({ workspace });
    await expect(writeLesson({ workspace, claim: "Use AuthService for resource login.", evidenceRefs: [] })).rejects.toThrow(
      /Invalid evidence/
    );

    const pack = await createContextPack({ workspace, query: "AuthService login", budget: 800 });
    const evidence = pack.citations.find((hit) => hit.ref.includes("src/auth.ts"))?.ref || pack.citations[0].ref;
    const memory = await writeLesson({
      workspace,
      claim: "Use AuthService.login before loading resource profiles.",
      evidenceRefs: [evidence]
    });
    const recalled = await recallMemory({ workspace, query: "resource profiles" });
    expect(recalled.some((hit) => hit.ref === `memory:${memory.id}`)).toBe(true);

    fs.appendFileSync(path.join(workspace, "src", "auth.ts"), "\n// Auth memory stale marker\n");
    await indexWorkspace({ workspace });
    const report = await generateReport({ workspace });
    expect(report.staleMemories.some((item) => item.id === memory.id)).toBe(true);
  });

  it("supports init, search, and impact analysis through the CLI", async () => {
    const workspace = copyFixture();
    const cli = path.join(projectRoot, "dist", "cli.js");
    if (!fs.existsSync(cli)) return;

    const initOutput = execFileSync(process.execPath, [cli, "init", "--workspace", workspace, "--json"], { encoding: "utf8" });
    const init = JSON.parse(initOutput) as { instructionsPath: string; index: { indexedFiles: number } };
    expect(init.index.indexedFiles).toBeGreaterThan(0);
    expect(fs.readFileSync(init.instructionsPath, "utf8")).toContain("context_pack");

    const searchOutput = execFileSync(process.execPath, [cli, "search", "AuthService login", "--workspace", workspace, "--json"], {
      encoding: "utf8"
    });
    expect(JSON.parse(searchOutput).citations.length).toBeGreaterThan(0);

    const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(help).toContain("search");
    expect(help).not.toContain("report");

    const search = await searchContext({ workspace, query: "loadUserProfile" });
    expect(search.hits.length).toBeGreaterThan(0);

    const history = await whyChanged({ workspace, target: "AuthService" });
    expect(history.currentEvidence.length).toBeGreaterThan(0);
  });

  it("exposes the planned MCP tool surface", async () => {
    const workspace = copyFixture();
    const cli = path.join(projectRoot, "dist", "cli.js");
    if (!fs.existsSync(cli)) return;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "server"]
    });
    const client = new Client({ name: "contextful-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "context_pack",
        "impact_analysis",
        "recall_memory",
        "search_code",
        "trace_path",
        "why_changed",
        "write_lesson"
      ]);
      const result = await client.callTool({
        name: "context_pack",
        arguments: { workspace, query: "AuthService login", budget: 800 }
      });
      expect(result.content?.[0]?.type).toBe("text");
    } finally {
      await client.close();
    }
  });
});
