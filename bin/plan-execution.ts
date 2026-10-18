#!/usr/bin/env bun
// Read a finalized plan's `execution:` block and bind each task to its
// crew-dispatch rule. Firstmate runs this on plan-ready, then runs quota-axi on
// each task's profile array and fm-spawns the winner.
//
// Usage: bun bin/plan-execution.ts                 plans in the vault that carry an execution block
//        bun bin/plan-execution.ts <plan.md> [--config <crew-dispatch.json>] [--json]
// Exit 0: every task resolved (or the plan has no execution block: says so).
// Exit 1: malformed block or unknown rule id. Exit 2: usage or unreadable file.
// Output is TOON (docs/tool-standards.md); errors go to stdout with a suggestion.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { encode } from "@toon-format/toon";
import { parseExecution, profileLabel, resolveExecution, type DispatchConfig } from "../dashboard/lib/plan-execution.ts";
import { aliceVault, ROOT } from "../dashboard/lib/paths.ts";

const HELP = `command: plan-execution
summary: Bind each task in a finalized plan's execution block to its crew-dispatch rule and profiles
usage: bun bin/plan-execution.ts [<plan.md>] [--config <crew-dispatch.json>] [--json]
flags[3]{flag,default,description}:
  --config,fleet/home/config/crew-dispatch.json,the dispatch rules to resolve against
  --json,off,print the result as JSON
  --help,,show this help
examples[3]:
  bun bin/plan-execution.ts
  bun bin/plan-execution.ts ~/Workspace/brain/fleet/plans/feature/r4-crew-isolation.md
  bun bin/plan-execution.ts plan.md --config fleet/config/crew-dispatch.json --json`;

const args = process.argv.slice(2);

function fail(message: string, suggestion: string, code: number): never {
  console.log(encode({ error: message, suggestion }));
  process.exit(code);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
if (args[0] === "--version" || args[0] === "-v" || args[0] === "-V") {
  console.log("1.0.0");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--config") i++;
  else if (a.startsWith("-") && a !== "--json") fail(`unknown flag ${a}`, "valid flags: --config <file>, --json, --help", 2);
}

const json = args.includes("--json");
const cfgIdx = args.indexOf("--config");
const planPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--config");
const fmHome = process.env.FM_HOME ?? join(ROOT, "fleet", "home");
const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : join(fmHome, "config", "crew-dispatch.json");
if (cfgIdx >= 0 && !configPath) fail("--config needs a file", "bun bin/plan-execution.ts <plan.md> --config <crew-dispatch.json>", 2);

/** No plan given: the vault's plans that carry an execution block, newest first. */
function home(): void {
  const root = join(aliceVault(), "fleet", "plans");
  const found: { plan: string; tasks: number; modified: string }[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) {
        const text = readFileSync(p, "utf8");
        if (!/^execution:/m.test(text)) continue;
        found.push({ plan: relative(aliceVault(), p), tasks: parseExecution(text).tasks.length, modified: statSync(p).mtime.toISOString().slice(0, 10) });
      }
    }
  };
  walk(root);
  found.sort((a, b) => b.modified.localeCompare(a.modified));
  console.log(
    encode({
      bin: "~/Workspace/agents/bin/plan-execution.ts",
      description: "Bind a finalized plan's execution tasks to crew-dispatch rules and profiles",
      plans: found.length ? found : `0 plans with an execution block under ${relative(process.env.HOME ?? "", root) ? `~/${relative(process.env.HOME ?? "", root)}` : root}`,
      help: ["bun bin/plan-execution.ts <plan.md>", "bun bin/plan-execution.ts --help"],
    }),
  );
}

if (!planPath) {
  home();
  process.exit(0);
}

let markdown: string;
let config: DispatchConfig;
try {
  markdown = await readFile(planPath, "utf8");
} catch (e) {
  fail(`cannot read the plan: ${e instanceof Error ? e.message : String(e)}`, "pass the path of a plan note (bun bin/plan-execution.ts lists them)", 2);
}
try {
  config = JSON.parse(await readFile(configPath!, "utf8")) as DispatchConfig;
} catch (e) {
  fail(`cannot read the dispatch rules: ${e instanceof Error ? e.message : String(e)}`, "pass --config <crew-dispatch.json>", 2);
}

const parsed = parseExecution(markdown);
const { resolved, errors } = resolveExecution(parsed.tasks, config);
const allErrors = [...parsed.errors, ...errors];

if (json) {
  console.log(JSON.stringify({ plan: planPath, tasks: resolved, errors: allErrors }, null, 2));
} else if (parsed.tasks.length === 0 && allErrors.length === 0) {
  console.log(encode({ execution: "none: the plan has no execution block; dispatch each task by Jev or judgment" }));
} else {
  console.log(
    encode({
      ...(resolved.length ? { tasks: resolved.map((t) => ({ task: t.task, rule: t.rule, effort: t.effort ?? null, profiles: t.profiles.map(profileLabel).join(" | ") })) } : {}),
      ...(allErrors.length ? { errors: allErrors, suggestion: "send the plan back to the Architect with these errors; do not guess a rule" } : {}),
    }),
  );
}
process.exit(allErrors.length ? 1 : 0);
