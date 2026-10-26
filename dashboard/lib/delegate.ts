import { jevAsk } from "./jev.ts";
import { redact } from "./redact.ts";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { postBus } from "./bus-post.ts";
import { readShips } from "./fleet-layers.ts";
import { agentKeyEnv, keysForModels, withoutSecrets } from "./fleet-env.ts";
import { listWorkflows, once, updateWorkflow, upsertWorkflow } from "./journal.ts";
import { dashLog } from "./log.ts";
import { aliceVault, fleetInboxRoot, ROOT } from "./paths.ts";
import { pidAlive } from "./session.ts";
import { logShipEvent } from "./ship-log.ts";

/**
 * Delegation (resilient fleet runtime, R3): an officer hands a self-contained
 * task to a short-lived helper so its own context stays sparse.
 *
 * The helper is a fresh `pi -p` process (cheap model, read-only tools, no
 * session, the static helper prompt) started detached and recorded as a
 * journal workflow, so a node restart re-attaches or finishes it. When it
 * ends, its full answer goes to fleet/inbox/<officer>/delegations/<id>/result.md
 * and a two-to-three sentence summary goes onto the officer's bus; the event
 * router wakes the officer with it. The officer's context grows by the summary.
 *
 * Limits: FLEET_HELPERS_MAX running per officer (default 2), FLEET_HELPER_MINUTES
 * per helper (default 15), FLEET_HELPER_BUDGET_USD per officer per day
 * (default 2).
 */

const MODEL = process.env.FLEET_HELPER_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";
/** For tasks Jev judges hard (vault research note jev-system-one, Level 5C): reasoning across many sources, plans, debugging. */
const STRONG_MODEL = process.env.FLEET_HELPER_STRONG_MODEL ?? "openrouter/deepseek/deepseek-v4-pro";

/**
 * The cheapest model that can do the task: Jev picks easy (a lookup, a summary,
 * finding where something is) or hard; only a confident "hard" gets the strong
 * model. Free lanes are not options: helpers read the vault and repos.
 */
export async function helperModel(task: string, ask: typeof jevAsk = jevAsk): Promise<{ model: string; why: string }> {
  const r = await ask("helper-routing", { task: redact(task).slice(0, 2000) }, {
    difficulty: {
      type: "choice",
      instructions: "A read-only helper agent will do `task` by reading notes or code. How hard is it?",
      criteria: {
        easy: "A lookup or summary: find where something is, list or quote what a few notes or files say, answer a factual question about them",
        hard: "Reasoning across many notes or files: compare options, trace a bug, reconstruct a decision, draft a plan or design, judge trade-offs",
        other: "Unclear",
      },
    },
  }).catch(() => null);
  const a = r && r.ok ? r.answers.difficulty : undefined;
  if (a && a.type === "choice" && a.choice === "hard" && (a.probabilities.hard ?? a.confidence) >= 0.7) return { model: STRONG_MODEL, why: `hard task (Jev ${Math.round((a.probabilities.hard ?? a.confidence) * 100)}%)` };
  return { model: MODEL, why: a && a.type === "choice" ? `${a.choice} task` : "default" };
}
const MAX_RUNNING = Math.max(1, Number(process.env.FLEET_HELPERS_MAX) || 2);
const TIMEOUT_MS = Math.max(1, Number(process.env.FLEET_HELPER_MINUTES) || 15) * 60_000;
const BUDGET = Math.max(0, Number(process.env.FLEET_HELPER_BUDGET_USD ?? 2));
const HELPER_PROMPT = join(ROOT, "prompts", "system", "helper.md");
/** In the vault the helper is a librarian: it also gets the vault's map and conventions. */
const LIBRARIAN_PROMPT = join(ROOT, "prompts", "system", "librarian.md");

type Data = { from: string; task: string; where: string; cwd: string; model: string; dir: string; pid: number; started: string; cost?: number; summary?: string };
type Res = { ok: boolean; message: string; [k: string]: unknown };

function today(): string {
  return new Date().toLocaleDateString("sv");
}

/** What the helper spent today for this officer (finished delegations). */
export function helperSpentToday(from: string): number {
  return listWorkflows<Data>("delegation")
    .filter((w) => w.data.from === from && w.created.slice(0, 10) >= today().slice(0, 10) && typeof w.data.cost === "number")
    .reduce((n, w) => n + (w.data.cost ?? 0), 0);
}

/** Where the helper works: the vault (default), this agents repo ("fleet"), or a ship's repo. */
async function resolveWhere(where: string): Promise<string | null> {
  if (!where || where === "vault") return aliceVault();
  if (where === "fleet") return ROOT;
  return (await readShips()).find((s) => s.id === where)?.path ?? null;
}

/** First "Summary:" paragraph, else the first three sentences. */
export function summaryOf(text: string): string {
  const m = text.match(/Summary:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  const s = (m ? m[1]! : text).replace(/\s+/g, " ").trim();
  if (m) return s.slice(0, 600);
  return (s.match(/[^.!?]+[.!?]+/g) ?? [s]).slice(0, 3).map((x) => x.trim()).join(" ").slice(0, 600);
}

/** Parse a helper's JSON event stream: its final answer and what it cost. */
export function parseHelperOutput(jsonl: string): { text: string; cost: number; error: string } {
  let text = "";
  let cost = 0;
  let error = "";
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { role?: string; content?: unknown; usage?: { cost?: { total?: number } }; stopReason?: string; errorMessage?: string } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
    cost += e.message.usage?.cost?.total ?? 0;
    if (e.message.stopReason === "error") error = e.message.errorMessage ?? "error";
    const c = e.message.content;
    const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n") : "";
    if (t.trim()) text = t.trim();
  }
  return { text, cost, error };
}

const watching = new Set<string>();

/** Start a helper on a task; returns at once (the officer is woken when it ends). */
export async function startDelegation(from: string, task: string, where = "vault"): Promise<Res> {
  const t = task.trim();
  if (t.length < 20) return { ok: false, message: "Give the helper a self-contained task: what to find or do, where, and what the answer should contain." };
  const running = listWorkflows<Data>("delegation", "running").filter((w) => w.data.from === from);
  if (running.length >= MAX_RUNNING) return { ok: false, message: `${running.length} helpers are already working for you (${running.map((w) => w.id).join(", ")}); wait for one to finish.` };
  if (BUDGET && helperSpentToday(from) >= BUDGET) return { ok: false, message: `Helpers have spent today's $${BUDGET} for you; do it yourself or ask the captain to raise FLEET_HELPER_BUDGET_USD.` };
  const cwd = await resolveWhere(where);
  if (!cwd || !existsSync(cwd)) return { ok: false, message: `Unknown place "${where}": use vault, fleet, or a ship id.` };
  const id = `d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const dir = join(fleetInboxRoot(), from, "delegations", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.md"), `${t}\n`, "utf8");
  const out = openSync(join(dir, "out.jsonl"), "a");
  const { model, why } = await helperModel(t);
  let pid = 0;
  try {
    const proc = Bun.spawn(
      ["pi", "--mode", "json", "-p", "--no-session", "--no-skills", "--model", model, "--tools", "read,grep,find,ls", "--append-system-prompt", HELPER_PROMPT, ...(where === "vault" || !where ? ["--append-system-prompt", LIBRARIAN_PROMPT] : []), "-e", join(ROOT, "extensions", "cache-watch.ts"), t],
      { cwd, stdin: "ignore", stdout: out, stderr: out, detached: true, env: { ...withoutSecrets(process.env), ...keysForModels(await agentKeyEnv(), [model]), FLEET_AGENT_ID: `${from}-helper` } },
    );
    pid = proc.pid;
    void proc.exited.then(() => finishDelegation(id));
  } finally {
    closeSync(out);
  }
  upsertWorkflow("delegation", id, { from, task: t.slice(0, 2000), where, cwd, model, dir, pid, started: new Date().toISOString() } satisfies Data, { trace: `delegation-${id}` });
  watch(id, pid);
  logShipEvent("fleet", from, "delegation", `Helper ${id} started: ${t.slice(0, 160)}`, { id, where, model, why, trace: `delegation-${id}` });
  await dashLog("delegate", `${from} → ${id} (${where})`);
  return { ok: true, message: `Helper ${id} is working on it (${model}, ${why}, read-only, in ${where}). You will be woken with its summary; the full result will be at ${join(dir, "result.md")}. Carry on with other work or end your turn.`, id };
}

/** Kill a helper that runs past its time; the exit handler (or the watcher) finishes it. */
function watch(id: string, pid: number): void {
  if (watching.has(id)) return;
  watching.add(id);
  const started = Date.now();
  const timer = setInterval(() => {
    if (!pidAlive(pid)) {
      clearInterval(timer);
      watching.delete(id);
      void finishDelegation(id);
      return;
    }
    if (Date.now() - started > TIMEOUT_MS) {
      try {
        process.kill(-pid, "SIGTERM"); // its whole process group
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
  }, 5000);
}

/** Record a finished helper and wake its officer with the summary (at most once). */
export async function finishDelegation(id: string): Promise<void> {
  const w = listWorkflows<Data>("delegation").find((x) => x.id === id);
  if (!w || w.status !== "running") return;
  await once(id, "finish", async () => {
    let raw = "";
    try {
      raw = readFileSync(join(w.data.dir, "out.jsonl"), "utf8");
    } catch {
      /* nothing written */
    }
    const { text, cost, error } = parseHelperOutput(raw);
    const ok = Boolean(text) && !error;
    const summary = ok ? summaryOf(text) : `The helper did not finish: ${error || "it ended without an answer (timed out or stopped)"}.`;
    const result = join(w.data.dir, "result.md");
    writeFileSync(result, `# Helper ${id}\n\nTask: ${w.data.task}\n\n${text || summary}\n`, "utf8");
    updateWorkflow(id, { status: ok ? "done" : "failed", data: { cost, summary } });
    logShipEvent("fleet", w.data.from, "delegation", `Helper ${id} ${ok ? "finished" : "failed"}: ${summary.slice(0, 200)}`, { id, ok, cost, result, trace: w.trace });
    await postBus(w.data.from, { from: "helper", kind: ok ? "delegation-done" : "delegation-failed", summary: `Helper ${id}: ${summary}`, ref: result, cost: Math.round(cost * 10000) / 10000 });
    return { ok, cost };
  });
}

/** After a node restart: re-attach helpers still running, finish the ones that ended. */
export async function recoverDelegations(): Promise<void> {
  for (const w of listWorkflows<Data>("delegation", "running")) {
    if (w.data.pid && pidAlive(w.data.pid)) watch(w.id, w.data.pid);
    else await finishDelegation(w.id);
  }
}
