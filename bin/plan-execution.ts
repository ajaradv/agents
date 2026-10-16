// Read a finalized plan's `execution:` block and bind each task to its
// crew-dispatch rule. Firstmate runs this on plan-ready, then runs quota-axi on
// each task's profile array and fm-spawns the winner.
//
// Usage: bun bin/plan-execution.ts <plan.md> [--config <crew-dispatch.json>] [--json]
// Exit 0: every task resolved (or the plan has no execution block: prints "none").
// Exit 1: malformed block or unknown rule id. Exit 2: usage or unreadable file.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseExecution,
  profileLabel,
  resolveExecution,
  type DispatchConfig,
} from "../dashboard/lib/plan-execution.ts";
import { ROOT } from "../dashboard/lib/paths.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const cfgIdx = args.indexOf("--config");
const planPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--config");
const fmHome = process.env.FM_HOME ?? join(ROOT, "fleet", "home");
const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : join(fmHome, "config", "crew-dispatch.json");

if (!planPath || !configPath) {
  console.error("usage: bun bin/plan-execution.ts <plan.md> [--config <crew-dispatch.json>] [--json]");
  process.exit(2);
}

let markdown: string;
let config: DispatchConfig;
try {
  markdown = await readFile(planPath, "utf8");
  config = JSON.parse(await readFile(configPath, "utf8")) as DispatchConfig;
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const parsed = parseExecution(markdown);
const { resolved, errors } = resolveExecution(parsed.tasks, config);
const allErrors = [...parsed.errors, ...errors];

if (json) {
  console.log(JSON.stringify({ plan: planPath, tasks: resolved, errors: allErrors }, null, 2));
} else if (parsed.tasks.length === 0 && allErrors.length === 0) {
  console.log("execution: none (dispatch each task by Jev or judgment)");
} else {
  console.log("execution:");
  for (const t of resolved) {
    console.log(`  - task: ${t.task}`);
    console.log(`    rule: ${t.rule}${t.effort ? ` effort=${t.effort}` : ""}`);
    console.log(`    profiles: ${t.profiles.map(profileLabel).join(" | ")}`);
  }
  for (const e of allErrors) console.error(`error: ${e}`);
}
process.exit(allErrors.length ? 1 : 0);
