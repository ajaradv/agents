import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import { aliceVault, ROOT } from "./paths.ts";
import { parseExecution, profileLabel, resolveExecution, type DispatchConfig } from "./plan-execution.ts";
import { resolveNote } from "./vault-note.ts";

/**
 * plan_check (extensions/decisions.ts): the Architect's check of a plan's
 * `execution:` block, the same result `bun bin/plan-execution.ts <plan>` prints.
 * Only notes inside the vault (resolveNote refuses `..` and symlinks out).
 */
export function planCheck(path: string, deps: { vault?: string; configPath?: string } = {}): { ok: boolean; message: string } {
  const note = resolveNote(path, deps.vault ?? aliceVault());
  if (!note.ok) return note;
  const configPath = deps.configPath ?? join(process.env.FM_HOME ?? join(ROOT, "fleet", "home"), "config", "crew-dispatch.json");
  let config: DispatchConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as DispatchConfig;
  } catch (e) {
    return { ok: false, message: encode({ error: `cannot read the dispatch rules: ${e instanceof Error ? e.message : String(e)}`, suggestion: "tell the captain; the rules are fleet/home/config/crew-dispatch.json" }) };
  }
  const parsed = parseExecution(readFileSync(note.file, "utf8"));
  const { resolved, errors } = resolveExecution(parsed.tasks, config);
  const allErrors = [...parsed.errors, ...errors];
  if (!parsed.tasks.length && !allErrors.length) return { ok: true, message: encode({ plan: note.rel, execution: "none: the plan has no execution block; dispatch each task by Jev or judgment" }) };
  return {
    ok: allErrors.length === 0,
    message: encode({
      plan: note.rel,
      ...(resolved.length ? { tasks: resolved.map((t) => ({ task: t.task, rule: t.rule, effort: t.effort ?? null, profiles: t.profiles.map(profileLabel).join(" | ") })) } : {}),
      ...(allErrors.length ? { errors: allErrors, suggestion: "fix the execution block with these errors; do not guess a rule" } : {}),
    }),
  };
}
