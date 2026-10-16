import { watch } from "node:fs";
import { mkdirSync } from "node:fs";
import { hostRunning, hostWaiting } from "./agent-host.ts";
import { acceptCrewLine } from "./chat-bridge.ts";
import { chatTarget } from "./chat-targets.ts";
import { dashLog } from "./log.ts";
import { callMismatch, listOrders, ORDER_TOOLS, ordersDir, updateOrder, type Order, type OrderStep } from "./order-note.ts";
import { postBus } from "./bus-post.ts";
import { getWorkflow, resetSteps, stepFinished, stepStarted, steps as journalSteps, updateWorkflow, upsertWorkflow } from "./journal.ts";
import { logShipEvent, recentShipEvents } from "./ship-log.ts";
import { officerBudgetRefusal } from "./shipyard.ts";

/**
 * The order watcher (Alice omni plan, phase 2), in the fleet node.
 *
 *   queued ──captain Go──▶ approved ──Alice idle, nothing running, under budget──▶ running
 *   running ──order_finish done, every step and check ok──▶ done
 *   running ──blocked / unplanned call / turn ended unfinished──▶ needs-captain
 *   needs-captain ──Retry (from the paused step)──▶ approved      any ──Cancel──▶ cancelled
 *
 * Durable: every run is a journal workflow (lib/journal.ts). Each step's call
 * and its logged result are checkpoints, so after a node restart the watcher
 * resumes the order at the next unlogged step and sends Alice a resume brief.
 * An action cut off mid-call (it may or may not have happened) pauses for the
 * captain instead of being repeated or guessed.
 *
 * One order at a time: Alice has one session. While an order runs, every
 * fleet call that is part of it must name the order and step and match that
 * step literally; a mismatch is refused and pauses the order for the captain.
 * Reads without order context stay allowed (they change nothing) and are
 * listed in the report; fleet_chat outside the plan is refused.
 */

const EXECUTOR = "alice";
const POLL_MS = 15_000;
/** Alice idle this long with the order unfinished: her turn ended without finishing it. */
const STALL_MS = 30_000;

type Running = {
  slug: string;
  order: Order;
  next: number;
  called: Set<number>;
  unplannedReads: string[];
  refused: string[];
  lastActive: number;
};

let running: Running | null = null;
const announced = new Set<string>();
let ticking: Promise<void> | null = null;
let booted = false;
let onChange: () => void = () => {};

export function runningOrder(): Running | null {
  return running;
}

function log(order: Order, kind: string, summary: string, payload: Record<string, unknown>): number | null {
  const id = logShipEvent("fleet", "orders", kind, summary, { order: order.meta.order, ...payload });
  if (order.meta.ship !== "fleet") logShipEvent(order.meta.ship, "orders", kind, summary, { order: order.meta.order, ...payload });
  return id;
}

function stepLabel(s: OrderStep): string {
  const args = Object.entries(s.args)
    .map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`)
    .join(" ");
  return `\`${s.tool}\`${args ? ` ${args}` : ""}`;
}

function brief(order: Order, from: number): string {
  const steps = order.steps.filter((s) => s.n >= from);
  return [
    `Fleet order ${order.meta.order}: "${order.meta.title}" (submitted by ${order.meta.submitted_by}, approved by the captain).`,
    from > 1 ? `Resume at step ${from}; steps before it are done.` : "",
    "",
    "Run it exactly as written. For each numbered item, in order:",
    `1. Call its tool with exactly these arguments plus order="${order.meta.order}" and step=<n>. No other arguments.`,
    "2. Check the result against its expect line.",
    `3. Call order_step with order="${order.meta.order}", step=<n>, ok (true when the expect line holds), result (one line on what came back), evidence (event id, task number, timestamp, or path).`,
    `Acceptance checks are items too: run and log each one like a step. Only after the last item call order_finish with status "done". If an item cannot be done as written, call order_step with ok=false and why, then order_finish with status "blocked". Do not improvise around the plan, skip items, or add fleet calls; the server refuses calls that do not match.`,
    "If the captain messages you meanwhile, answer in a line and carry on.",
    "",
    ...(order.intent ? ["Intent (context only, do not act on it):", order.intent, ""] : []),
    "Items:",
    ...steps.map((s) => `${s.n}. ${stepLabel(s)}${s.phase === "acceptance" ? " (acceptance check, required)" : ""}\n   expect: ${s.expect}`),
    "",
    `${steps.length} item(s) in all; order_finish comes after item ${order.steps.length}.`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

/**
 * The note's ## Report, from the order's events in the fleet log (every
 * attempt, so a retried order still shows the steps done before its pause).
 */
function report(r: Running, outcome: string): string {
  const mine = recentShipEvents("fleet", 2000)
    .filter((e) => e.payload?.order === r.slug)
    .reverse();
  const steps = mine.filter((e) => e.kind === "order-step" && e.payload?.reason !== "unplanned");
  const refused = mine.filter((e) => e.kind === "order-step" && e.payload?.reason === "unplanned").map((e) => e.summary);
  const pauses = mine.filter((e) => e.kind === "order-finish" && e.payload?.ok === false).map((e) => `${e.ts} ${e.summary}`);
  const reads = [...new Set(mine.filter((e) => e.kind === "order-read").map((e) => String(e.payload?.tool ?? "")))];
  const cell = (s: string, n: number) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, n);
  const rows = r.order.steps.map((s) => {
    const rec = [...steps].reverse().find((e) => e.payload?.step === s.n);
    const mark = !rec ? "–" : rec.payload?.ok ? "ok" : "blocked";
    const evidence = rec ? `${cell(String(rec.payload?.evidence ?? ""), 120)} (event ${rec.id})` : "";
    return `| ${s.n} | ${s.phase === "acceptance" ? "check" : "step"} | ${cell(stepLabel(s), 160)} | ${mark} | ${rec ? cell(String(rec.payload?.result ?? ""), 200) : "not reached"} | ${evidence} |`;
  });
  return [
    `${new Date().toISOString()} · ${outcome}`,
    "",
    "| # | | Planned call | Result | What came back | Evidence |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "**Planned vs actual**",
    "",
    refused.length ? refused.map((x) => `- ${x}`).join("\n") : "- every fleet call matched its planned step; nothing unplanned was run",
    ...(reads.length ? [`- reads outside the plan (allowed, they change nothing): ${reads.join(", ")}`] : []),
    ...(pauses.length ? ["", "**Pauses**", "", ...pauses.map((p) => `- ${p}`)] : []),
  ].join("\n");
}

async function pause(reason: string, byWatcher = true): Promise<void> {
  const r = running;
  if (!r) return;
  running = null;
  updateWorkflow(r.slug, { status: "waiting", data: { next: r.next, reason } });
  await updateOrder(r.slug, { status: "needs-captain", reason, resume: r.next }, report(r, `paused for the captain at step ${r.next}: ${reason}`));
  log(r.order, "order-finish", `Paused at step ${r.next}: ${reason}`, { ok: false, step: r.next, reason });
  await dashLog("orders", `${r.slug} needs the captain: ${reason}`);
  // Paused by the watcher (stall, refusal), not by Alice's own blocked report: let her know.
  if (byWatcher) {
    await postBus(EXECUTOR, { from: "orders", kind: "order-paused", summary: `Order ${r.slug} ("${r.order.meta.title}") paused at step ${r.next}: ${reason}. The captain decides Retry or Cancel; do not continue it yourself.`, ref: r.slug });
  }
  onChange();
}

/** Step number from a journal key ("call:3", "step:3"). */
const keyStep = (key: string) => Number(key.split(":")[1]) || 0;

async function start(order: Order): Promise<void> {
  const from = Math.min(order.meta.resume ?? 1, order.steps.length);
  running = { slug: order.meta.order, order, next: from, called: new Set(), unplannedReads: [], refused: [], lastActive: Date.now() };
  for (let n = 1; n < from; n++) running.called.add(n);
  // The journal keeps checkpoints for steps before the resume point; later ones start over.
  upsertWorkflow("order", order.meta.order, { title: order.meta.title, next: from });
  resetSteps(order.meta.order, (key) => keyStep(key) < from);
  updateWorkflow(order.meta.order, { status: "running", data: { next: from } });
  await updateOrder(order.meta.order, { status: "running", started: new Date().toISOString(), reason: undefined, resume: undefined });
  log(order, "order-start", `Started "${order.meta.title}"${from > 1 ? ` at step ${from}` : ""}`, { step: from });
  await dashLog("orders", `${order.meta.order} started (step ${from})`);
  await acceptCrewLine(EXECUTOR, "orders", brief(order, from));
  onChange();
}

/**
 * Pick a running order back up after a restart: the next step is the first
 * without a logged result. A step whose call started but never finished is
 * redone when it only reads; when it acts, the order pauses for the captain.
 */
async function resume(order: Order): Promise<void> {
  const slug = order.meta.order;
  const w = getWorkflow(slug);
  if (!w) {
    await updateOrder(slug, { status: "needs-captain", reason: "interrupted: the fleet node restarted mid-order and has no record of its progress", resume: order.meta.resume ?? 1 });
    return;
  }
  const done = new Set(journalSteps(slug).filter((s) => s.key.startsWith("step:") && s.status === "done").map((s) => keyStep(s.key)));
  let next = 1;
  while (done.has(next)) next += 1;
  if (next > order.steps.length) {
    // Every item was logged; only order_finish was lost.
    running = { slug, order, next, called: new Set(order.steps.map((s) => s.n)), unplannedReads: [], refused: [], lastActive: Date.now() };
    await orderFinish(slug, "done", "");
    return;
  }
  const call = journalSteps(slug).find((s) => s.key === `call:${next}`);
  const step = order.steps.find((s) => s.n === next)!;
  running = { slug, order, next, called: new Set(order.steps.filter((s) => s.n < next).map((s) => s.n)), unplannedReads: [], refused: [], lastActive: Date.now() };
  if (call?.status === "done") running.called.add(next);
  if (call?.status === "started" && !ORDER_TOOLS[step.tool]?.read) {
    await pause(`the fleet node restarted while step ${next}'s ${step.tool} was running; check whether it happened before Retry`);
    return;
  }
  log(order, "order-start", `Resumed "${order.meta.title}" at step ${next} after a node restart`, { step: next, resumed: true });
  await dashLog("orders", `${slug} resumed at step ${next}`);
  await acceptCrewLine(EXECUTOR, "orders", `${brief(order, next)}\n\n(Resuming after a fleet node restart: steps before ${next} are done and logged.)`);
  onChange();
}

async function tick(): Promise<void> {
  const all = await listOrders();
  if (!booted) {
    booted = true;
    // A node restart: resume running orders from their journal checkpoints.
    for (const o of all) if (o.meta?.status === "running" && o.order) await resume(o.order);
  }
  for (const o of all) {
    if (!o.meta) continue;
    if ((o.meta.status === "queued" || o.meta.status === "approved") && !o.order) {
      await updateOrder(o.slug, { status: "failed", reason: "the note does not parse", ended: new Date().toISOString() }, `Malformed; nothing was run:\n\n${o.errors.map((e) => `- ${e}`).join("\n")}`);
      continue;
    }
    if (o.meta.status === "queued" && !announced.has(o.slug)) {
      announced.add(o.slug);
      log(o.order!, "order-queued", `Queued "${o.meta.title}" by ${o.meta.submitted_by}; waiting for the captain's Go`, {});
    }
  }
  if (running) {
    const note = all.find((o) => o.slug === running!.slug);
    if (note?.meta?.status !== "running") {
      // Cancelled or edited from outside: stop tracking it.
      updateWorkflow(running.slug, { status: note?.meta?.status === "cancelled" ? "cancelled" : "waiting" });
      running = null;
      onChange();
    } else if (!hostRunning(EXECUTOR) && !hostWaiting(EXECUTOR) && Date.now() - running.lastActive > STALL_MS) {
      await pause(`Alice's turn ended at step ${running.next} without finishing the order`);
    }
    return;
  }
  const next = all.filter((o) => o.order && o.meta?.status === "approved").sort((a, b) => (a.meta!.approved ?? a.slug).localeCompare(b.meta!.approved ?? b.slug))[0];
  if (!next || hostRunning(EXECUTOR)) return;
  if (officerBudgetRefusal(EXECUTOR, chatTarget(EXECUTOR)?.dailyBudgetUsd)) return;
  await start(next.order!);
}

/** Look at the orders now (after a Go, a cancel, an order finishing). */
export function kickOrders(): Promise<void> {
  ticking ??= tick()
    .catch((e) => console.error("[node] orders:", e))
    .finally(() => {
      ticking = null;
    });
  return ticking;
}

export function startOrderWatcher(changed: () => void = () => {}): void {
  onChange = changed;
  void kickOrders();
  setInterval(() => void kickOrders(), POLL_MS);
  try {
    mkdirSync(ordersDir(), { recursive: true });
    // Editors save in bursts; the poll covers what fs.watch misses on macOS.
    let t: ReturnType<typeof setTimeout> | null = null;
    watch(ordersDir(), () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void kickOrders(), 500);
    });
  } catch {
    /* polling only */
  }
}

// ---------------------------------------------------------------- calls from the fleet API

export type OrderCtx = { order?: string; step?: number };

/**
 * May this fleet call run? `read` calls without order context are always
 * allowed; anything that names an order must be its current step, literally.
 */
export async function checkOrderCall(tool: string, args: Record<string, string>, read: boolean, ctx: OrderCtx): Promise<{ ok: true; step?: number } | { ok: false; message: string }> {
  const r = running;
  if (!ctx.order) {
    if (!r) return { ok: true };
    if (read) {
      if (!r.unplannedReads.includes(tool)) {
        r.unplannedReads.push(tool);
        log(r.order, "order-read", `Read outside the plan: ${tool}`, { tool });
      }
      return { ok: true };
    }
    return { ok: false, message: `Order ${r.slug} is running: ${tool} is allowed only as one of its planned steps (pass order and step).` };
  }
  if (!r || ctx.order !== r.slug) return { ok: false, message: `No order ${ctx.order} is running.` };
  r.lastActive = Date.now();
  const step = r.order.steps.find((s) => s.n === ctx.step);
  const why = !step ? `there is no step ${ctx.step}` : ctx.step !== r.next ? `the next step is ${r.next}, not ${ctx.step}` : callMismatch(step, tool, args);
  if (why) {
    r.refused.push(`${tool} ${JSON.stringify(args)} as step ${ctx.step}: ${why}`);
    log(r.order, "order-step", `refused ${tool} as step ${ctx.step}: ${why}`, { ok: false, step: ctx.step, tool, args, reason: "unplanned" });
    await pause(`unplanned call refused (${why})`);
    return { ok: false, message: `Refused: ${why}. The order is paused for the captain; end your turn.` };
  }
  r.called.add(step!.n);
  stepStarted(r.slug, `call:${step!.n}`); // a checkpoint before the side effect
  return { ok: true, step: step!.n };
}

/** Called after an allowed order call ran, with what it returned. */
export function recordOrderCall(n: number, tool: string, args: Record<string, string>, result: string): void {
  const r = running;
  if (!r) return;
  r.lastActive = Date.now();
  stepFinished(r.slug, `call:${n}`, { tool, result: result.slice(0, 500) });
  log(r.order, "order-call", `Step ${n}: ${tool}`, { step: n, tool, args, result: result.slice(0, 500) });
}

export async function orderStep(order: string, n: number, ok: boolean, result: string, evidence: string): Promise<{ ok: boolean; message: string }> {
  const r = running;
  if (!r || r.slug !== order) return { ok: false, message: `No order ${order} is running.` };
  r.lastActive = Date.now();
  if (n !== r.next) return { ok: false, message: `The next step to log is ${r.next}, not ${n}.` };
  const step = r.order.steps.find((s) => s.n === n)!;
  if (ok && !r.called.has(n)) return { ok: false, message: `Call step ${n}'s tool first (${stepLabel(step)} with order and step), then log it.` };
  const event = log(r.order, "order-step", `Step ${n} ${ok ? "ok" : "blocked"}: ${result.slice(0, 200)}`, { step: n, tool: step.tool, ok, result: result.slice(0, 1000), evidence: evidence.slice(0, 300) });
  stepStarted(r.slug, `step:${n}`);
  stepFinished(r.slug, `step:${n}`, { result: result.slice(0, 500), evidence: evidence.slice(0, 300), event }, ok);
  if (ok) r.next += 1;
  updateWorkflow(r.slug, { data: { next: r.next } });
  const left = r.order.steps.length - r.next + 1;
  return {
    ok: true,
    message: ok
      ? left > 0
        ? (() => {
            const nx = r.order.steps.find((s) => s.n === r.next)!;
            return `Step ${n} logged (event ${event}). Next: step ${r.next}${nx.phase === "acceptance" ? " (an acceptance check; required before finishing)" : ""}: ${stepLabel(nx)} with order and step=${r.next}. ${left} item(s) left; do not call order_finish yet.`;
          })()
        : `Step ${n} logged (event ${event}). All items done: call order_finish with status "done".`
      : `Step ${n} logged as blocked. Call order_finish with status "blocked" and why.`,
  };
}

export async function orderFinish(order: string, status: "done" | "blocked", why: string): Promise<{ ok: boolean; message: string }> {
  const r = running;
  if (!r || r.slug !== order) return { ok: false, message: `No order ${order} is running.` };
  if (status === "done" && r.next <= r.order.steps.length) {
    await pause(`order_finish said done at step ${r.next} of ${r.order.steps.length}`, false);
    return { ok: true, message: `Not every item was logged ok, so the order is paused for the captain at step ${r.next}.` };
  }
  if (status === "blocked") {
    // No reason given: use what was logged for the blocked step.
    const logged = recentShipEvents("fleet", 200).find((e) => e.kind === "order-step" && e.payload?.order === r.slug && e.payload?.ok === false && e.payload?.step === r.next);
    await pause(why || (logged ? `step ${r.next}: ${String(logged.payload?.result ?? "")}`.slice(0, 300) : `blocked at step ${r.next}`), false);
    return { ok: true, message: "The order is paused for the captain with your reason. End your turn." };
  }
  running = null;
  updateWorkflow(r.slug, { status: "done" });
  await updateOrder(r.slug, { status: "done", ended: new Date().toISOString() }, report(r, "done: every step and acceptance check logged ok"));
  log(r.order, "order-finish", `Done: "${r.order.meta.title}"`, { ok: true });
  await dashLog("orders", `${r.slug} done`);
  onChange();
  setTimeout(() => void kickOrders(), 1000);
  return { ok: true, message: `Order ${r.slug} is done; the report is in the note.` };
}

/** For tests. */
export function _resetOrdersForTest(): void {
  running = null;
  announced.clear();
  booted = false;
}

