import { frontmatter } from "./fleet-layers.ts";
import { cursorOn } from "./models-config.ts";

/**
 * One entry of a plan's frontmatter `execution:` list, written by the Architect.
 * `rule` is a crew-dispatch.json rule id, never a concrete model.
 */
export type ExecutionTask = {
  task: string;
  rule: string;
  effort?: string;
  why?: string;
};

export type DispatchProfile = {
  harness: string;
  model?: string;
  effort?: string;
  provider?: string;
};

export type DispatchRule = {
  id?: string;
  when: string;
  use: DispatchProfile | DispatchProfile[];
};

export type DispatchConfig = { rules?: DispatchRule[]; default?: unknown };

export type ResolvedTask = ExecutionTask & { profiles: DispatchProfile[] };

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Harnesses whose profiles accept an `effort` field (crew-dispatch validator). */
const EFFORT_HARNESSES = new Set(["claude", "pi", "pi-signed", "omp", "muse", "codex"]);

export function parseExecution(markdown: string): { tasks: ExecutionTask[]; errors: string[] } {
  const fm = frontmatter(markdown);
  const raw = fm?.execution;
  if (raw === undefined || raw === null) return { tasks: [], errors: [] };
  if (!Array.isArray(raw)) return { tasks: [], errors: ["execution must be a list"] };
  const tasks: ExecutionTask[] = [];
  const errors: string[] = [];
  raw.forEach((item, i) => {
    const n = `execution[${i}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${n} must be a map`);
      return;
    }
    const o = item as Record<string, unknown>;
    const task = String(o.task ?? "").trim();
    const rule = String(o.rule ?? "").trim();
    if (!task) errors.push(`${n} needs task`);
    if (!rule) errors.push(`${n} needs rule`);
    const effort = o.effort == null ? undefined : String(o.effort).trim();
    if (effort && !EFFORTS.has(effort)) errors.push(`${n} effort must be one of ${[...EFFORTS].join(", ")}`);
    if ("model" in o) errors.push(`${n} names a model; use a rule id instead`);
    if (task && rule) {
      tasks.push({ task, rule, ...(effort ? { effort } : {}), ...(o.why ? { why: String(o.why) } : {}) });
    }
  });
  return { tasks, errors };
}

function profilesOf(rule: DispatchRule): DispatchProfile[] {
  return Array.isArray(rule.use) ? rule.use : [rule.use];
}

/**
 * Bind each task to its rule's profiles. An effort hint replaces the effort on
 * profiles that already carry one; Cursor-style profiles never gain the field.
 * While Cursor is off (fleet/config/models.json) `harness: cursor` profiles are
 * dropped, as crews will not get them; a rule with nothing left is an error.
 */
export function resolveExecution(
  tasks: ExecutionTask[],
  config: DispatchConfig,
  cursor: boolean = cursorOn(),
): { resolved: ResolvedTask[]; errors: string[] } {
  const byId = new Map((config.rules ?? []).filter((r) => r.id).map((r) => [r.id!, r]));
  const resolved: ResolvedTask[] = [];
  const errors: string[] = [];
  for (const t of tasks) {
    const rule = byId.get(t.rule);
    if (!rule) {
      errors.push(`unknown rule "${t.rule}" for task "${t.task}" (known: ${[...byId.keys()].join(", ")})`);
      continue;
    }
    const profiles = profilesOf(rule)
      .filter((p) => cursor || p.harness !== "cursor")
      .map((p) => (t.effort && p.effort !== undefined && EFFORT_HARNESSES.has(p.harness) ? { ...p, effort: t.effort } : { ...p }));
    if (!profiles.length) {
      errors.push(`rule "${t.rule}" has nothing left for task "${t.task}": Cursor is off`);
      continue;
    }
    resolved.push({ ...t, profiles });
  }
  return { resolved, errors };
}

export function profileLabel(p: DispatchProfile): string {
  return `${p.harness}${p.model ? ":" + p.model : ""}${p.effort ? "/" + p.effort : ""}${p.provider ? " provider=" + p.provider : ""}`;
}
