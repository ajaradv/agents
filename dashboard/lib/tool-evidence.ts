import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { journalDb } from "./journal.ts";
import { metricsDb } from "./metrics.ts";
import { fleetInboxRoot, nodeStateDir } from "./paths.ts";

/**
 * What the fleet helmsman reviews about the fleet's own tools (vault task
 * fleet-tool-standards): evidence that a tool is drifting from
 * docs/tool-standards.md or docs/system-one.md. Code gathers it; the helmsman
 * judges it and files `tool` proposals.
 */

type Row = Record<string, string | number>;

function q(db: () => Database, sql: string, ...args: string[]): Row[] {
  try {
    return db().query(sql).all(...args) as Row[];
  } catch {
    return [];
  }
}

/** Tool results by size in the agents' session logs of the last `days` (the tools that flood context). */
export function largestToolOutputs(days = 7, root = fleetInboxRoot()): { tool: string; calls: number; avgChars: number; maxChars: number }[] {
  const since = Date.now() - days * 86_400_000;
  const stats = new Map<string, { calls: number; total: number; max: number }>();
  const names = new Map<string, string>();
  let agents: string[] = [];
  try {
    agents = readdirSync(root).filter((a) => !a.startsWith("."));
  } catch {
    return [];
  }
  for (const a of agents) {
    const dir = join(root, a, "sessions");
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        if (statSync(path).mtimeMs < since) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line) continue;
          let e: { message?: { role?: string; toolName?: string; toolCallId?: string; content?: unknown } };
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          const m = e.message;
          const content = Array.isArray(m?.content) ? (m!.content as { type?: string; name?: string; id?: string; text?: string }[]) : [];
          for (const c of content) if (c.type === "toolCall" && c.id && c.name) names.set(c.id, c.name);
          if (m?.role !== "toolResult") continue;
          const tool = m.toolName ?? names.get(m.toolCallId ?? "") ?? "?";
          const size = content.filter((c) => c.type === "text").reduce((n, c) => n + (c.text?.length ?? 0), 0);
          const s = stats.get(tool) ?? { calls: 0, total: 0, max: 0 };
          s.calls++;
          s.total += size;
          s.max = Math.max(s.max, size);
          stats.set(tool, s);
        }
      } catch {
        /* unreadable session */
      }
    }
  }
  return [...stats].map(([tool, s]) => ({ tool, calls: s.calls, avgChars: Math.round(s.total / s.calls), maxChars: s.max })).sort((a, b) => b.avgChars * b.calls - a.avgChars * a.calls).slice(0, 10);
}

/** The "Tool evidence" section of the fleet ship's helm review, as markdown lines. */
export function toolEvidence(days = 7): string[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const failures = q(journalDb, "SELECT agent, tool, COUNT(*) AS n, MAX(error) AS sample FROM tool_failures WHERE ts >= ? AND noise = 0 GROUP BY agent, tool ORDER BY n DESC LIMIT 12", since);
  const gate = q(metricsDb, "SELECT decision, COUNT(*) AS n FROM gate_log WHERE ts >= ? GROUP BY decision ORDER BY n DESC", since);
  const held = q(metricsDb, "SELECT agent, summary, decision, reason FROM gate_log WHERE ts >= ? AND decision IN ('hold', 'stop', 'observe-hold', 'observe-stop', 'screen-flag') ORDER BY id DESC LIMIT 8", since);
  const jev = q(metricsDb, "SELECT use, COUNT(*) AS calls, SUM(1 - ok) AS failed, ROUND(SUM(cost), 5) AS cost FROM jev_calls WHERE ts >= ? GROUP BY use ORDER BY calls DESC", since);
  let doctor = "not run yet";
  try {
    const d = JSON.parse(readFileSync(join(nodeStateDir(), "vault-doctor.json"), "utf8")) as { problems?: { note: string; detail: string }[] };
    doctor = d.problems?.length ? d.problems.slice(0, 6).map((p) => `${p.note}: ${p.detail}`).join("; ") : "no problems";
  } catch {
    /* not run */
  }
  const big = largestToolOutputs(days);
  return [
    `## Tool evidence (last ${days} days; judge against docs/tool-standards.md and docs/system-one.md)`,
    "",
    `- Tool failures by agent: ${failures.length ? failures.map((f) => `${f.agent} ${f.tool} (${f.n}; e.g. "${String(f.sample).slice(0, 100)}")`).join("; ") : "none"}`,
    `- Tool gate decisions: ${gate.length ? gate.map((g) => `${g.decision} ${g.n}`).join(", ") : "none"}`,
    `- Held, stopped, or flagged: ${held.length ? held.map((h) => `${h.agent} ${h.decision}: ${String(h.summary).slice(0, 90)} (${String(h.reason).slice(0, 60)})`).join("; ") : "none"}`,
    `- Jev calls by use: ${jev.length ? jev.map((j) => `${j.use} ${j.calls}${Number(j.failed) ? ` (${j.failed} failed)` : ""}, $${j.cost}`).join("; ") : "none"}`,
    `- Largest tool outputs (avg characters × calls): ${big.length ? big.map((b) => `${b.tool} ${b.calls} calls, avg ${b.avgChars}, max ${b.maxChars}`).join("; ") : "none"}`,
    `- Vault doctor: ${doctor}`,
    "",
    "For the fleet ship, file `tool` proposals (name: the tool, script, or extension; text: what to fix and against which rule) when the evidence shows a tool drifting: outputs that flood context, failures that recur, gate holds a rule could decide, Jev uses that fail or hold too often. Read the tool's code before proposing.",
  ];
}
