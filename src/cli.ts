#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import { indexWorkspace, watchWorkspace } from "./indexer.js";
import { writeLesson } from "./memory.js";
import { generateReport, renderEvidencePackMarkdown, renderReport } from "./report.js";
import { createContextPack, searchContext } from "./search.js";
import { runMcpServer } from "./mcp-server.js";
import { type ReportFormat } from "./types.js";

const program = new Command();

program
  .name("cxf")
  .description("Contextful: local-first context search, evidence packs, and memory for coding agents.")
  .version("0.1.0");

program
  .command("index")
  .description("Index a workspace into .contextful.")
  .option("--workspace <path>", "Workspace path.", process.cwd())
  .option("--watch", "Watch for changes and re-index.")
  .action(async (options: { workspace: string; watch?: boolean }) => {
    if (options.watch) {
      await watchWorkspace(options.workspace, (result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      });
      return;
    }
    process.stdout.write(`${JSON.stringify(await indexWorkspace({ workspace: options.workspace }), null, 2)}\n`);
  });

program
  .command("daemon")
  .description("Run the local indexing daemon for a workspace.")
  .option("--workspace <path>", "Workspace path.", process.cwd())
  .action(async (options: { workspace: string }) => {
    await watchWorkspace(options.workspace, (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  });

program
  .command("query")
  .description("Create an evidence pack for a query.")
  .argument("<query>", "Query to answer from indexed context.")
  .option("--workspace <path>", "Workspace path.", process.cwd())
  .option("--budget <tokens>", "Approximate token budget.", parseInteger, 2000)
  .option("--json", "Print JSON instead of Markdown.")
  .action(async (query: string, options: { workspace: string; budget: number; json?: boolean }) => {
    const pack = await createContextPack({ workspace: options.workspace, query, budget: options.budget });
    process.stdout.write(options.json ? `${JSON.stringify(pack, null, 2)}\n` : renderEvidencePackMarkdown(pack));
  });

program
  .command("search")
  .description("Search indexed context without compiling a full evidence pack.")
  .argument("<query>", "Search query.")
  .option("--workspace <path>", "Workspace path.", process.cwd())
  .option("--limit <count>", "Max hits.", parseInteger, 10)
  .option("--kind <kind>", "all|code|docs|symbols|memory", "all")
  .action(async (query: string, options: { workspace: string; limit: number; kind: "all" | "code" | "docs" | "symbols" | "memory" }) => {
    process.stdout.write(`${JSON.stringify(await searchContext({ ...options, query }), null, 2)}\n`);
  });

program
  .command("report")
  .description("Generate a context report.")
  .option("--workspace <path>", "Workspace path.", process.cwd())
  .option("--format <format>", "markdown|json|html", "markdown")
  .action(async (options: { workspace: string; format: ReportFormat }) => {
    process.stdout.write(renderReport(await generateReport({ workspace: options.workspace }), parseReportFormat(options.format)));
  });

const memory = program.command("memory").description("Manage evidence-backed agent memory.");

memory
  .command("add")
  .description("Store an evidence-backed lesson.")
  .requiredOption("--claim <text>", "Lesson claim.")
  .requiredOption("--evidence <ref...>", "Evidence ref(s), for example file:src/auth.ts:1-20.")
  .option("--workspace <path>", "Workspace path.", process.cwd())
  .option("--scope <scope>", "Memory scope.", "repo")
  .option("--confidence <number>", "Confidence from 0 to 1.", parseFloat, 0.7)
  .action(async (options: { workspace: string; claim: string; evidence: string[]; scope: string; confidence: number }) => {
    process.stdout.write(
      `${JSON.stringify(
        await writeLesson({
          workspace: options.workspace,
          claim: options.claim,
          evidenceRefs: options.evidence,
          scope: options.scope,
          confidence: options.confidence
        }),
        null,
        2
      )}\n`
    );
  });

program
  .command("server")
  .description("Run the MCP stdio server.")
  .action(async () => {
    await runMcpServer();
  });

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function parseReportFormat(value: string): ReportFormat {
  if (value === "markdown" || value === "json" || value === "html") return value;
  throw new Error(`Unsupported report format: ${value}`);
}
