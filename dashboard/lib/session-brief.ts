import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factsBrief } from "./facts.ts";
import { aliceVault, fleetInboxRoot } from "./paths.ts";
import { readVaultTasks, vaultNextSteps } from "./vault-tasks.ts";

/**
 * The session brief (vault plan alice-memory-and-tools, M1): a few lines the
 * node writes for Alice's prompt, so a session starts knowing what is due and
 * what is next without a tool call per question. bin/launch puts it in her
 * Memory block. Built by code from the vault tasks, never by a model, and
 * capped: the tools (vault_tasks next) have the live, complete view.
 */

export const BRIEF_CAP = 1500;
const DUE_WITHIN_DAYS = 7;
const STEPS_SHOWN = 2;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cutAt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The brief for `today` (YYYY-MM-DD), never longer than BRIEF_CAP bytes. */
export function buildBrief(today: string, vault = aliceVault()): string {
  const { tasks } = readVaultTasks(vault);
  const next = vaultNextSteps(vault);
  const head = `# Session brief ${today} (built by the node from the vault tasks; vault_tasks filter=next is live)`;

  const horizon = addDays(today, DUE_WITHIN_DAYS);
  const due = tasks.filter((t) => t.due && t.due <= horizon && t.status !== "done").sort((a, b) => a.due.localeCompare(b.due));
  const dueLines = due.map((t) => `- ${t.id}: ${t.due < today ? `overdue since ${t.due}` : t.due === today ? "due today" : `due ${t.due}`}`);

  const rank = (t: Record<string, unknown>) => (t.status === "in-progress" ? 0 : 1);
  // Tasks with open steps that are not waiting on another task (closeable ones have their own list).
  const active = next.tasks.filter((t) => !t.waitingOn && (t.next as string[]).length).sort((a, b) => rank(a) - rank(b));
  const activeLines = active.map((t) => {
    const steps = (t.next as string[]).slice(0, STEPS_SHOWN).map((s) => cutAt(s, 90));
    return `- ${t.id} [${t.status}, ${t.priority}] ${t.progress}${steps.length ? `: ${steps.join(" / ")}` : ""}`;
  });
  const closeable = next.tasks.filter((t) => t.closeable).map((t) => String(t.id));

  const sections: [string, string[]][] = [
    ["Due within 7 days or overdue", dueLines],
    ["Closeable (all Done-when items checked)", closeable.length ? [`- ${closeable.join(", ")}`] : []],
    ["Active tasks, next steps", activeLines],
  ];
  return `${fitSections(head, sections, BRIEF_CAP, ": vault_tasks").text}\n`;
}

/**
 * `head`, then each `## title` section with as many whole lines as fit under `cap` bytes, leaving
 * room for the line that says how many were left out ("- (+N more<moreHint>)"). Empty sections are
 * skipped. Stops at the first section whose title no longer fits; `cut` names it and the rest.
 */
export function fitSections(head: string, sections: [string, string[]][], cap: number, moreHint = ""): { text: string; cut: string[] } {
  const out = [head];
  let size = Buffer.byteLength(head);
  const cut: string[] = [];
  for (const [title, lines] of sections) {
    if (!lines.length) continue;
    if (cut.length) {
      cut.push(title);
      continue;
    }
    const t = `\n## ${title}`;
    if (size + Buffer.byteLength(t) + 60 > cap) {
      cut.push(title);
      continue;
    }
    out.push(t);
    size += Buffer.byteLength(t) + 1;
    let shown = 0;
    for (const l of lines) {
      if (size + Buffer.byteLength(l) + 60 > cap) break;
      out.push(l);
      size += Buffer.byteLength(l) + 1;
      shown++;
    }
    if (shown < lines.length) {
      out.push(`- (+${lines.length - shown} more${moreHint})`);
      size += 40;
    }
  }
  return { text: out.join("\n"), cut };
}

export const briefPath = (agent = "alice") => join(fleetInboxRoot(), agent, "brief.md");

/** Write Alice's brief when it changed; true when it did. */
export function writeSessionBrief(today = new Date().toLocaleDateString("en-CA"), vault = aliceVault()): boolean {
  const text = buildBrief(today, vault);
  const file = briefPath();
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    /* first write */
  }
  mkdirSync(join(fleetInboxRoot(), "alice"), { recursive: true });
  writeFileSync(file, text, "utf8");
  return true;
}

/** Room for the current facts in Alice's prompt; with the brief it keeps the session start under 3 KB (bin/launch). */
export const FACTS_CAP = 1200;

export const factsPath = (agent = "alice") => join(fleetInboxRoot(), agent, "facts.md");

/** Write Alice's current facts when they changed; true when it did. Called on the brief's schedule and after each fact_set. */
export function writeSessionFacts(): boolean {
  const text = factsBrief(FACTS_CAP);
  const file = factsPath();
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    if (!text) return false; // no facts yet, no file
  }
  mkdirSync(join(fleetInboxRoot(), "alice"), { recursive: true });
  writeFileSync(file, text, "utf8");
  return true;
}
