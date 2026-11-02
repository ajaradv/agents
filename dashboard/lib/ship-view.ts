import { hostRunning } from "./node-client.ts";
import { listChatTargets, type ChatTarget } from "./chat-targets.ts";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { humanizeError, plainSummary } from "./humanize.ts";
import { editableBody, listOrders, ORDER_TOOLS, type OrderMeta } from "./order-note.ts";
import { escapeHtml } from "./quota.ts";
import { gateStatus, type GateReport } from "./gates.ts";
import { liveLedgerHtml, pastLedgerHtml } from "./ledger-view.ts";
import { hasHelmsman, listProposals, proposalLine, type Proposal } from "./helm.ts";
import { readShipConfig, recentConfigChanges, shipTemplates } from "./ship-config.ts";
import { laptopStatus } from "./laptop.ts";
import { exeSailable, exeVoyages, vmPreview } from "./exe-voyages.ts";
import { isPaused } from "./exe-paused.ts";
import { laptopSailable, laptopVoyages } from "./laptop-host.ts";
import { QUEUE_KINDS, queueView, type QueueItem, type QueueKind } from "./decision-queue.ts";
import { listSpecs, parseSpec } from "./specs.ts";
import { voyageWorktree } from "./voyage-worktree.ts";
import { nodePublicUrl } from "./worker-host.ts";
import { OFFICER_SHIP, shipOf } from "./ship-events.ts";
import { readMemorySync, voyageMemoryNotes } from "./memory-sync.ts";
import { voyageId } from "./metrics.ts";
import { recentManeuvers, type Maneuver } from "./ship-maneuvers.ts";
import { recentShipEvents, shipTurnTotals, type ShipEvent } from "./ship-log.ts";
import { listTasks, taskProgress, type VoyageTask, waitingOn } from "./voyage-tasks.ts";
import { crewBudget, crewRoles, listVoyages, MODES, readyToSail, shipChecklist, spentToday, type CheckItem, type Voyage } from "./shipyard.ts";
import { CONDITION_LABEL, conditionOf, GAUGE_DETENTS, gaugeColor, gaugeDetents, supplyRemaining, voyageProgress, WEATHER_LABEL, weatherOf, type Condition, type Weather } from "./voyage-progress.ts";

/**
 * Harbor (every ship) and ship deck (one ship) partials. Read-only: crew status
 * comes from the agent host and the ship's log, maneuvers from the ship's
 * sssf.db, Firstmate's crews from the rail's task list.
 */

export type CrewStatus = "working" | "waiting" | "idle" | "asleep";

export type CrewCard = {
  target: ChatTarget;
  status: CrewStatus;
  activity: string;
  lastAt: string | null;
  cost7d: number;
  turns7d: number;
  errors7d: number;
};

const DAY_MS = 86_400_000;

/** `running` defaults to the dashboard's mirror of the node; the node passes its own host state. */
export function crewStatus(id: string, events: ShipEvent[], running = hostRunning(id)): { status: CrewStatus; activity: string; lastAt: string | null } {
  const mine = events.filter((e) => e.actor === id);
  const last = mine[0];
  if (running) {
    const tool = mine.find((e) => e.kind === "tool");
    return { status: "working", activity: tool?.summary ?? "Thinking", lastAt: last?.ts ?? null };
  }
  // Waiting: its newest line is a question the captain has not answered since.
  const question = mine.find((e) => e.kind === "question");
  if (question) {
    // Rows logged before captain lines carried `to` count for every crewmate.
    const answered = events.some(
      (e) =>
        e.actor === "captain" &&
        (e.kind === "answer" || e.kind === "chat-in") &&
        e.ts > question.ts &&
        (e.payload?.to === undefined || e.payload.to === id),
    );
    if (!answered) return { status: "waiting", activity: question.summary, lastAt: question.ts };
  }
  if (!last) return { status: "asleep", activity: "Not started on this ship yet", lastAt: null };
  const said = mine.find((e) => e.kind === "chat-out");
  return { status: "idle", activity: said?.summary ?? last.summary, lastAt: last.ts };
}

export function crewCards(ship: ShipRow, events: ShipEvent[]): CrewCard[] {
  const totals = shipTurnTotals(ship.id, new Date(Date.now() - 7 * DAY_MS).toISOString());
  return listChatTargets()
    .agents.filter((t) => t.ship === ship.id)
    .map((target) => {
      const s = crewStatus(target.id, events);
      const t = totals[target.id];
      return { target, ...s, cost7d: t?.cost ?? 0, turns7d: t?.turns ?? 0, errors7d: t?.errors ?? 0 };
    });
}

export function firstmateCrews(ship: ShipRow): ChatTarget[] {
  return listChatTargets().workers.filter((w) => (w.project ?? "").toLowerCase() === ship.id.toLowerCase());
}

/** Someone is actively working: a crewmate's session is running, or a Firstmate worker is busy. */
export function shipRunning(cards: CrewCard[], fm: ChatTarget[]): boolean {
  return cards.some((c) => c.status === "working") || fm.some((w) => /work|run|busy|active|spawn|build/i.test(w.state ?? ""));
}

/** True when a queued or paused order on this ship is waiting on the captain. */
export function orderNeedsCaptain(orders: Awaited<ReturnType<typeof listOrders>>, shipId: string): boolean {
  return orders.some((o) => o.meta && (o.meta.status === "needs-captain" || o.meta.status === "queued") && o.meta.ship === shipId);
}

export function timeAgo(iso: string | null): string {
  return ago(iso);
}

export function crewStatusLabel(s: CrewStatus): string {
  return STATUS_LABEL[s];
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Chat text without Markdown punctuation, for one-line previews. */
function plain(s: string): string {
  return s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
}

function usd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
}

/** The weather glyph for a tile/deck, with the word beside it when asked. */
function weatherGlyphHtml(weather: Weather, withWord = false): string {
  const label = WEATHER_LABEL[weather];
  const word = withWord ? ` <span class="weather-word">${label}</span>` : "";
  return `<span class="weather-glyph weather-${weather}" role="img" aria-label="${label}" title="${label}"></span>${word}`;
}

/** A segmented 8-detent bar of budget left today, or "no ration set" without one. */
function supplyGaugeHtml(spend: number, budget: number | null): string {
  if (budget === null || budget <= 0) {
    return `<span class="supply-gauge supply-none" title="No daily budget set">no ration set</span>`;
  }
  const remaining = supplyRemaining(spend, budget)!;
  const color = gaugeColor(remaining);
  const lit = gaugeDetents(remaining);
  const detents = Array.from({ length: GAUGE_DETENTS }, (_, i) => `<span class="supply-detent${i < lit ? " is-lit" : ""}" aria-hidden="true"></span>`).join("");
  return `<span class="supply-gauge supply-${color}" title="Budget left today">${detents}<span class="supply-figure">${usd(budget - spend)} left</span></span>`;
}

const STATUS_LABEL: Record<CrewStatus, string> = { working: "Working", waiting: "Needs you", idle: "Idle", asleep: "Not started" };

function portrait(t: ChatTarget, size = 56): string {
  return t.art
    ? `<img class="portrait" src="${escapeHtml(t.art)}" width="${size}" height="${size}" alt="" />`
    : `<span class="portrait portrait-initials" style="width:${size}px;height:${size}px">${escapeHtml(t.label.slice(0, 2).toUpperCase())}</span>`;
}

/** In the yard (not ready to sail), under sail (open voyage or crew at work), or docked. */
export function shipState(ready: boolean, voyage: Voyage | null, cards: CrewCard[], fmCrews: ChatTarget[]): { state: "yard" | "sailing" | "docked"; label: string } {
  if (voyage || cards.some((c) => c.status === "working") || fmCrews.some((w) => /work|run|busy|active|spawn|build/i.test(w.state ?? ""))) {
    return { state: "sailing", label: "Under sail" };
  }
  if (!ready) return { state: "yard", label: "In the yard" };
  return { state: "docked", label: "Docked" };
}

// ---------------------------------------------------------------- harbor

/** The officers (Alice, the designer, the architect): their cards with today's spend against their daily budgets. */
export function officerCards(events: ShipEvent[]): CrewCard[] {
  const totals = shipTurnTotals(OFFICER_SHIP, new Date(Date.now() - 7 * DAY_MS).toISOString());
  return listChatTargets()
    .agents.filter((t) => !t.ship && shipOf(t.id) === OFFICER_SHIP)
    .map((target) => {
      const s = crewStatus(target.id, events);
      const t = totals[target.id];
      return { target, ...s, cost7d: t?.cost ?? 0, turns7d: t?.turns ?? 0, errors7d: t?.errors ?? 0 };
    });
}

/** The Flagship on the Harbor: the officers' ship, with what waits on the captain there. */
async function flagshipTileHtml(): Promise<string> {
  const cards = officerCards(recentShipEvents(OFFICER_SHIP, 200));
  const open = queueView().open.length;
  const working = cards.filter((c) => c.status === "working").length;
  const waiting = cards.filter((c) => c.status === "waiting").length;
  const spend = cards.reduce((n, c) => n + spentToday(OFFICER_SHIP, c.target.id), 0);
  return `<a class="d-card d-card-border bg-base-100 ship-tile flagship-tile" href="/ships/${OFFICER_SHIP}" data-ship="${OFFICER_SHIP}">
      <div class="ship-sprite" aria-hidden="true"><span class="ship-hull"></span><span class="ship-mast"></span><span class="ship-sail"></span><span class="ship-flag"></span></div>
      <div class="stack-tight">
        <div class="between"><h3 class="ship-name">Flagship</h3>${waiting ? `<span class="d-badge d-badge-sm d-badge-error">${waiting} need${waiting === 1 ? "s" : ""} you</span>` : `<span class="d-badge d-badge-outline d-badge-sm">${working ? "working" : "at anchor"}</span>`}</div>
        <p class="muted">The officers: ${cards.map((c) => escapeHtml(c.target.label)).join(", ") || "none"} · decision queue ${open} open · today ${usd(spend)}</p>
      </div>
    </a>`;
}

/**
 * The Flagship's deck: the officers (who decide with the captain and run the
 * fleet's orders), the decision queue, orders, and the officers' log. It is not
 * a repo ship: no voyages, rig, or shipyard.
 */
export async function flagshipDeckHtml(): Promise<string> {
  const events = recentShipEvents(OFFICER_SHIP, 200);
  const cards = officerCards(events);
  const labels = new Map(cards.map((c) => [c.target.id, c.target.label]));
  const budgetLine = (c: CrewCard) => {
    const b = c.target.dailyBudgetUsd ?? 0;
    return b ? `${escapeHtml(c.target.label)} ${usd(spentToday(OFFICER_SHIP, c.target.id))} of ${usd(b)} today` : "";
  };
  const budgets = cards.map(budgetLine).filter(Boolean);
  const rows = collapseLog(events);
  return `<div class="ship-deck stack">
    <div class="ship-head between">
      <div class="row">
        <a class="d-btn d-btn-sm" href="/harbor" data-harbor>← Harbor</a>
        <div>
          <h3 class="ship-name">Flagship</h3>
          <p class="muted path">The officers, on the hub: they decide with the captain (design and spec sessions), run orders, and watch the fleet.</p>
        </div>
      </div>
      <div class="row-wrap"><span class="d-badge d-badge-outline d-badge-sm">7d ${usd(cards.reduce((n, c) => n + c.cost7d, 0))}</span></div>
    </div>

    <section class="stack">
      <h3>Officers</h3>
      ${cards.length ? `<div class="crew-grid">${cards.map(crewCardHtml).join("")}</div>` : `<p class="muted">No officers are registered (agents/&lt;id&gt;/agent.yaml).</p>`}
      ${budgets.length ? `<p class="muted">Daily budgets (daily_budget_usd in each officer's agent.yaml): ${budgets.join(" · ")}</p>` : ""}
    </section>

    ${await decisionQueueHtml()}
    ${await ordersPanelHtml()}

    <section class="stack ship-log-wrap">
      <h3 id="ship-log">Flagship's log</h3>
      ${rows.length ? `<ol class="ship-log">${rows.slice(0, 80).map((r) => logRowHtml(r.event, labels, r.repeats)).join("")}</ol>` : `<p class="muted">Nothing logged yet. The officers' turns, delegations, router wakes, and orders land here.</p>`}
    </section>
  </div>`;
}

export async function harborHtml(): Promise<string> {
  const ships = await readShips();
  if (!ships.length) return `<p class="muted">No ships yet. Register one with bin/stamp-ship.</p>`;
  const orders = await listOrders();
  const tiles = ships.map(async (ship) => {
    const events = recentShipEvents(ship.id, 200);
    const cards = crewCards(ship, events);
    const fm = firstmateCrews(ship);
    const voyages = await listVoyages(ship.id);
    const voyage = voyages.find((v) => v.status === "sailing") ?? null;
    const st = shipState(readyToSail(await shipChecklist(ship)), voyage, cards, fm);
    const waiting = cards.filter((c) => c.status === "waiting").length;
    const needsYou = waiting > 0 || orderNeedsCaptain(orders, ship.id);
    const { progress, condition } = voyageProgress(ship, voyage, { state: st.state, running: shipRunning(cards, fm), needsYou });
    const maneuvers = voyage ? recentManeuvers(ship.path) : [];
    let spend = 0;
    let budget = 0;
    let hasBudget = false;
    for (const role of ship.crew) {
      const b = await crewBudget(ship.id, role);
      if (b !== null) {
        hasBudget = true;
        budget += b;
      }
      spend += spentToday(ship.id, `${ship.id}-${role}`);
    }
    const weather = weatherOf({ events, maneuvers, spend, budget: hasBudget ? budget : null, state: st.state });
    const conditionWord = CONDITION_LABEL[condition];
    const pct = Math.round(progress * 100);
    const deck = [...cards.map((c) => c.target), ...fm].slice(0, 6);
    const badge =
      condition === "needs-you"
        ? `<span class="d-badge d-badge-sm d-badge-error">${waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : conditionWord}</span>`
        : `<span class="d-badge d-badge-outline d-badge-sm">${conditionWord}</span>`;
    const progressRow = voyage
      ? `<div class="ship-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${conditionWord}"><span class="ship-progress-bar" style="width:${pct}%"></span><span class="ship-condition cond-${condition}">${conditionWord}</span></div>`
      : "";
    return `<a class="d-card d-card-border bg-base-100 ship-tile is-${st.state} cond-${condition}" href="/ships/${encodeURIComponent(ship.id)}" data-ship="${escapeHtml(ship.id)}">
      <div class="ship-sprite" aria-hidden="true"><span class="ship-hull"></span><span class="ship-mast"></span><span class="ship-sail"></span><span class="ship-flag"></span><span class="ship-wake"></span></div>
      <div class="stack-tight">
        <div class="between">
          <h3 class="ship-name">${escapeHtml(ship.id)}</h3>
          <span class="row">${weatherGlyphHtml(weather)}${badge}</span>
        </div>
        <p class="muted ship-meta">${escapeHtml(ship.orchestrator === "firstmate" ? "Orchestrator: Firstmate" : `Orchestrator: ${ship.orchestrator}`)} · ${escapeHtml(ship.mode || "mode unset")}${ship.adws.length ? ` · ${ship.adws.length} ADWs` : ""}</p>
        ${voyage ? `<p class="ship-voyage">⚑ ${escapeHtml(voyage.goal.slice(0, 120))}</p>` : ""}
        ${progressRow}
        ${supplyGaugeHtml(spend, hasBudget ? budget : null)}
        <div class="ship-deck-faces">${deck.length ? deck.map((t) => portrait(t, 36)).join("") : `<span class="muted">No crew aboard</span>`}</div>
      </div>
    </a>`;
  });
  return `${await laptopBarHtml(ships)}${exeBarHtml(ships)}<div class="harbor">${await flagshipTileHtml()}${(await Promise.all(tiles)).join("")}</div>
  <details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100 new-ship">
    <summary class="d-collapse-title">Build a new ship</summary><div class="d-collapse-content">
    <form class="stack shipyard-form" data-api="/api/ships" data-then="ship">
      <div class="form-grid">
        <label class="stack-tight">Ship id <input class="d-input d-input-sm" name="id" required pattern="[a-z][a-z0-9_-]{0,40}" placeholder="pochteca" /></label>
        <label class="stack-tight">Repo path <input class="d-input d-input-sm" name="path" required placeholder="/Users/you/Workspace/project" /></label>
        <label class="stack-tight">Delivery mode <select class="d-select d-select-sm" name="mode">${MODES.map((m) => `<option${m === "no-mistakes" ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="stack-tight">Start from <select class="d-select d-select-sm" name="template"><option value="">a blank ship</option>${shipTemplates().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)} template</option>`).join("")}</select></label>
        <label class="stack-tight">Register with Firstmate (one-line description, optional) <input class="d-input d-input-sm" name="firstmate" placeholder="Leave empty to run it with its own crew" /></label>
      </div>
      <label class="row"><input class="d-checkbox d-checkbox-sm" type="checkbox" name="factory" /> Install the SSSF factory (writes adws/ and .claude/skills/sssf into the repo)</label>
      <div class="row"><button class="d-btn d-btn-neutral d-btn-sm" type="submit">Lay the keel</button><span class="muted" data-note></span></div>
    </form>
  </div></details>`;
}

/**
 * The Harbor's laptop switch (lib/laptop-host.ts): whether ships may sail on
 * the captain's laptop, and the voyages there now, each with Move to hub, for
 * the end of the day. Only on a hub that has a laptop worker.
 */
const RIG_LABEL = { pending: "waiting to rig", rigging: "rigging…", ready: "ready", failed: "rigging failed" } as const;

/** The open voyage's own copy of the app (lib/rigging.ts): state, preview, and Rig again. */
export function voyageRigHtml(ship: ShipRow): string {
  const rec = ship.rig ? voyageWorktree(ship.id)?.rig : undefined;
  if (!rec) return "";
  const w = voyageWorktree(ship.id);
  const where = w?.host === "laptop" ? "on the laptop" : w?.host === "vm" ? (w.vm && isPaused(w.vm) ? "on an exe.dev VM (paused; resumes on the next crew turn)" : "on an exe.dev VM") : "on the hub";
  // The crew keeps the localhost URL in its brief (it runs on the VM); the captain's is the VM's.
  const preview = w?.vm ? vmPreview(w.vm, rec.preview) : rec.preview;
  const held = rec.brief ? ` The brief to ${escapeHtml(rec.brief.to)} waits until it is ready.` : "";
  return `<section class="d-card d-card-border bg-base-100 voyage-rig is-${rec.state}"><div class="d-card-body d-card-sm stack-tight">
    <div class="between">
      <span><strong>Voyage stack</strong> · <span class="${rec.state === "failed" ? "warn" : "muted"}">${RIG_LABEL[rec.state]}</span> · <span class="muted">${escapeHtml(rec.project)} ${where}, port ${rec.port}</span></span>
      <form class="row shipyard-form" data-api="/api/ships/${encodeURIComponent(ship.id)}/rig"><button class="d-btn d-btn-sm${rec.state === "failed" ? " d-btn-neutral" : ""}" type="submit"${rec.state === "rigging" ? " disabled" : ""}>Rig again</button><span class="muted" data-note></span></form>
    </div>
    ${rec.state === "ready" && preview ? `<p>Preview: <a href="${escapeHtml(preview)}" target="_blank" rel="noopener">${escapeHtml(preview)}</a>${where === "on the laptop" ? ` <span class="muted">(open it on the laptop)</span>` : ""}</p>` : ""}
    ${rec.state === "failed" && rec.message ? `<details><summary class="warn">What failed</summary><pre class="memory-text">${escapeHtml(rec.message.slice(-2000))}</pre></details>` : ""}
    ${held ? `<p class="muted">${held.trim()}</p>` : ""}
  </div></section>`;
}

async function laptopBarHtml(ships: ShipRow[]): Promise<string> {
  if (!process.env.FLEET_LAPTOP_URL) return "";
  const lv = laptopVoyages();
  const st = await laptopStatus();
  const awake = st.up ? "the laptop is awake" : "the laptop is asleep or offline";
  const there = ships.filter((s) => voyageWorktree(s.id)?.host === "laptop");
  const rows = there
    .map((s) => {
      const vm = s.isolation === "vm";
      return `<li class="between"><span><strong>${escapeHtml(s.id)}</strong> is sailing on the laptop${st.up ? "" : " (waiting for it)"}</span>${
        vm
          ? `<span class="muted">its crew needs Gondolin: it stays on the laptop</span>`
          : `<form class="row shipyard-form" data-api="/api/ships/${encodeURIComponent(s.id)}/move" data-confirm="Move ${escapeHtml(s.id)}'s voyage to the hub? The crew stops, the branch is pushed from the laptop, and the hub carries on from it."><button class="d-btn d-btn-sm" type="submit">Move to hub</button><span class="muted" data-note></span></form>`
      }</li>`;
    })
    .join("");
  return `<section class="d-card d-card-border bg-base-100 laptop-bar"><div class="d-card-body d-card-sm stack-tight">
    <form class="between shipyard-form" data-api="/api/laptop-voyages">
      <span><strong>Laptop voyages ${lv.on ? "on" : "off"}</strong> · <span class="muted">${awake}. ${lv.on ? "Ships may sail on the laptop while it is awake." : "New voyages sail on the hub."}</span></span>
      <input type="hidden" name="on" value="${lv.on ? "0" : "1"}" />
      <span class="row"><button class="d-btn d-btn-sm${lv.on ? "" : " d-btn-neutral"}" type="submit">${lv.on ? "Turn off (closing the laptop)" : "Turn on"}</button><span class="muted" data-note></span></span>
    </form>
    ${rows ? `<ul class="stack-tight">${rows}</ul>` : ""}
  </div></section>`;
}

/**
 * The Harbor's exe.dev switch (lib/exe-voyages.ts): whether ships that prefer
 * the laptop sail on an exe.dev VM while it is away, and the voyages on VMs
 * now, each with Move to hub. Shown on a hub whose node has a tailnet address.
 */
function exeBarHtml(ships: ShipRow[]): string {
  const ev = exeVoyages();
  if (!ev.on && !nodePublicUrl()) return "";
  const there = ships.filter((s) => voyageWorktree(s.id)?.host === "vm");
  const rows = there
    .map((s) => `<li class="between"><span><strong>${escapeHtml(s.id)}</strong> is sailing on ${escapeHtml(voyageWorktree(s.id)?.vm ?? "an exe.dev VM")}</span><form class="row shipyard-form" data-api="/api/ships/${encodeURIComponent(s.id)}/move" data-confirm="Move ${escapeHtml(s.id)}'s voyage to the hub? The crew stops, the branch is pushed from the VM, the hub carries on from it, and the VM is removed."><button class="d-btn d-btn-sm" type="submit">Move to hub</button><span class="muted" data-note></span></form></li>`)
    .join("");
  return `<section class="d-card d-card-border bg-base-100 laptop-bar"><div class="d-card-body d-card-sm stack-tight">
    <form class="between shipyard-form" data-api="/api/exe-voyages">
      <span><strong>exe.dev voyages ${ev.on ? "on" : "off"}</strong> · <span class="muted">${ev.on ? "Ships that prefer the laptop sail on an exe.dev VM while the laptop is away." : "Ships that prefer the laptop sail on the hub."}</span></span>
      <input type="hidden" name="on" value="${ev.on ? "0" : "1"}" />
      <span class="row"><button class="d-btn d-btn-sm${ev.on ? "" : " d-btn-neutral"}" type="submit">${ev.on ? "Turn off" : "Turn on"}</button><span class="muted" data-note></span></span>
    </form>
    ${rows ? `<ul class="stack-tight">${rows}</ul>` : ""}
  </div></section>`;
}

/** The Set a course form's "Sail on" choice: shown on a hub with a laptop worker or exe.dev voyages on. */
export type SailChoice = { show: boolean; laptop: boolean; why: string; prefer: "hub" | "laptop"; exe?: { ok: boolean; why: string } };

async function sailChoice(ship: ShipRow): Promise<SailChoice> {
  const exe = exeVoyages().on && ship.isolation !== "vm" ? await exeSailable(ship.id).catch((e) => ({ ok: false, why: String(e) })) : undefined;
  if (!process.env.FLEET_LAPTOP_URL) return { show: Boolean(exe), laptop: false, why: "the hub has no laptop worker", prefer: "hub", ...(exe ? { exe } : {}) };
  const can = await laptopSailable();
  const prefer = readShipConfig(ship.id)?.sail_on === "laptop" && can.ok ? "laptop" : "hub";
  return { show: true, laptop: can.ok, why: can.why, prefer, ...(exe ? { exe } : {}) };
}

// ---------------------------------------------------------------- ship deck

function crewCardHtml(c: CrewCard): string {
  const t = c.target;
  return `<article class="d-card d-card-border bg-base-100 crew-card is-${c.status}">
    ${portrait(t, 64)}
    <div class="stack-tight crew-body">
      <div class="between">
        <h4 class="sheet-title">${escapeHtml(t.label)}</h4>
        <span class="crew-status">${STATUS_LABEL[c.status]}</span>
      </div>
      <p class="crew-activity">${escapeHtml(plain(c.activity).slice(0, 220))}</p>
      <p class="muted crew-meta">${t.backupModel ? `<span class="warn" title="${escapeHtml(`Configured: ${t.model ?? ""}. ${t.backupReason ?? ""}`)}">on backup ${escapeHtml(t.backupModel)}</span>` : escapeHtml(t.model ?? "")}${c.lastAt ? ` · ${ago(c.lastAt)}` : ""} · 7d ${usd(c.cost7d)} over ${c.turns7d} turn${c.turns7d === 1 ? "" : "s"}${c.errors7d ? ` · <a class="warn" href="#ship-log" @click.prevent="showFailedLog()">${c.errors7d} failed</a>` : ""}</p>
      <div class="row"><a class="d-btn d-btn-neutral d-btn-sm" href="?chat=${encodeURIComponent(t.id)}" data-chat="${escapeHtml(t.id)}">Chat</a></div>
    </div>
  </article>`;
}

/**
 * The open voyage's memory (lib/memory-sync.ts): the crew's shared scratchpad
 * and each crewmate's plan and compaction state. A voyage on another host is
 * mirrored here every 30s; the line under the title says how fresh it is.
 */
export function voyageMemoryHtml(ship: ShipRow, voyage: Voyage | null): string {
  if (!voyage || ship.orchestrator !== "lead") return "";
  const notes = voyageMemoryNotes(ship.id, ship.crew);
  const host = voyageWorktree(ship.id)?.host ?? "local";
  const sync = host === "local" ? null : readMemorySync(ship.id);
  const fresh =
    host === "local"
      ? ""
      : !sync?.synced
        ? `<p class="muted">Kept on ${escapeHtml(sync?.host ?? host)}; not mirrored yet${sync?.message ? ` (${escapeHtml(sync.message.slice(0, 120))})` : ""}.</p>`
        : `<p class="muted">Mirrored from ${escapeHtml(sync.host)} ${ago(sync.synced)}${sync.message ? `; the last try failed (${escapeHtml(sync.message.slice(0, 120))}), so this may be stale` : ""}.</p>`;
  const body = notes.length
    ? notes.map((n) => `<details class="memory-note"><summary>${escapeHtml(n.label)} <span class="muted">· ${ago(n.updated)}</span></summary><pre class="memory-text">${escapeHtml(n.text.length > 6000 ? `…${n.text.slice(-6000)}` : n.text)}</pre></details>`).join("")
    : `<p class="muted">Nothing written yet. The crew's scratchpad, plans, and state appear here as they write them.</p>`;
  return `<section class="stack voyage-memory">
      <h3>Voyage memory</h3>
      ${fresh}
      ${body}
    </section>`;
}

function fmCrewHtml(w: ChatTarget): string {
  return `<article class="d-card d-card-border bg-base-100 crew-card is-firstmate">
    ${portrait(w, 48)}
    <div class="stack-tight crew-body">
      <div class="between"><h4>${escapeHtml(w.label)}</h4>${w.state && w.state !== "unknown" ? `<span class="crew-status">${escapeHtml(w.state)}</span>` : ""}</div>
      <p class="muted crew-meta">Firstmate ${escapeHtml(w.role ?? "crew")}</p>
      <div class="row"><a class="d-btn d-btn-sm" href="?chat=${encodeURIComponent(w.id)}" data-chat="${escapeHtml(w.id)}">Chat</a></div>
    </div>
  </article>`;
}

const KIND_LABEL: Record<string, string> = {
  "chat-in": "You",
  "chat-out": "Said",
  question: "Asked",
  answer: "You answered",
  "turn-start": "Started",
  "turn-end": "Finished",
  tool: "Tool",
  notice: "Notice",
  task: "Task",
  crew: "Crew message",
  maneuver: "Maneuver",
  "voyage-start": "Set sail",
  "voyage-end": "Docked",
  shipyard: "Shipyard",
};

function logRowHtml(e: ShipEvent, labels: Map<string, string>, repeats = 1): string {
  const cost = e.kind === "turn-end" && typeof e.payload?.cost === "number" && e.payload.cost > 0 ? ` · ${usd(e.payload.cost as number)}` : "";
  const cls = isBad(e) ? " is-bad" : e.kind === "question" ? " is-ask" : "";
  const who = e.actor === "captain" ? "Captain" : labels.get(e.actor) ?? e.actor;
  const raw = e.kind === "turn-start" ? "" : e.summary;
  // Errors as one sentence; markdown punctuation dropped; long text folded.
  const bad = Boolean(cls.trim() === "is-bad");
  const text = bad ? humanizeError(raw) : e.kind === "tool" ? raw : plainSummary(raw);
  const SHORT = 180;
  const body =
    text.length > SHORT
      ? `<details class="log-more"><summary>${escapeHtml(text.slice(0, SHORT))}…</summary>${escapeHtml(text.slice(SHORT, 1200))}</details>`
      : escapeHtml(text);
  const rawFold = bad && raw !== text ? `<details class="raw"><summary>Details</summary><pre>${escapeHtml(raw.slice(0, 2000))}</pre></details>` : "";
  return `<li class="log-row kind-${escapeHtml(e.kind)}${cls}" data-id="${e.id}">
    <time datetime="${escapeHtml(e.ts)}" title="${escapeHtml(e.ts)}">${escapeHtml(new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time>
    <span class="log-who">${escapeHtml(who)}</span>
    <span class="log-kind">${escapeHtml(e.kind === "turn-end" && cls ? "Failed" : KIND_LABEL[e.kind] ?? e.kind)}${cost}${repeats > 1 ? ` · ×${repeats}` : ""}</span>
    <span class="log-text">${body}${rawFold}</span>
  </li>`;
}

function maneuverHtml(m: Maneuver): string {
  const chain = m.phases
    .map((p) => {
      const cls = p.status === "pass" || p.status === "ok" || p.status === "done" ? "is-ok" : p.status === "running" ? "is-run" : p.status === "fail" || p.status === "error" ? "is-bad" : "";
      return `<li class="phase ${cls}" title="${escapeHtml(`${p.owner} · ${p.status}${p.attempt > 1 ? ` · attempt ${p.attempt}` : ""}${p.error ? ` · ${p.error}` : ""}`)}">${escapeHtml(p.name)}</li>`;
    })
    .join("");
  const err = m.phases.find((p) => p.error && p.status !== "pass");
  return `<article class="d-card d-card-border bg-base-100 maneuver">
    <div class="between"><h4>${escapeHtml(m.adwName)}</h4><span class="d-badge d-badge-sm ${m.status === "fail" ? "d-badge-error" : "d-badge-outline"}">${escapeHtml(m.status)}</span></div>
    <p class="muted">${escapeHtml(m.request.slice(0, 200))}</p>
    <ol class="phase-chain">${chain || `<li class="muted">No phases recorded</li>`}</ol>
    ${err ? `<p class="warn">${escapeHtml(err.name)}: ${escapeHtml((err.error ?? "").slice(0, 300))}</p>` : ""}
    <p class="muted">${escapeHtml(m.startedAt ? new Date(m.startedAt).toLocaleString() : "")}${m.cost ? ` · ${usd(m.cost)}` : ""} · <code>${escapeHtml(m.adwId)}</code></p>
  </article>`;
}

/** The helm: the helmsman's open proposals for the captain, and a way to ask for a review. */
async function helmHtml(ship: ShipRow): Promise<string> {
  const all = await listProposals(ship.id);
  const open = all.filter((p) => p.status === "open");
  const aboard = hasHelmsman(ship);
  const changes = recentConfigChanges(ship.id, 6);
  if (!aboard && !open.length && !changes.length) return "";
  const val = (v: string | null) => (v === null ? "none" : v.length > 60 ? `${v.slice(0, 59)}…` : v);
  const history = changes.length
    ? `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100"><summary class="d-collapse-title">Config changes · ${changes.length} recent · live in fleet/home/ships/${escapeHtml(ship.id)}.yaml</summary><ul class="d-collapse-content meter-list">${changes
        .map((c) => `<li><span><code>${escapeHtml(c.key)}</code> ${escapeHtml(val(c.old))} → ${escapeHtml(val(c.new))}${c.why ? ` <span class="muted">· ${escapeHtml(c.why.slice(0, 120))}</span>` : ""}</span><span class="muted">${escapeHtml(c.by)} · ${escapeHtml(timeAgo(c.ts))}</span></li>`)
        .join("")}</ul></details>`
    : "";
  const api = `/api/ships/${encodeURIComponent(ship.id)}/helm`;
  const kindLabel: Record<string, string> = { check: "New check", gate: "New gate", maneuver: "New maneuver", retire_maneuver: "Retire maneuver", allow_host: "Allow a host", note: "Note" };
  const card = (p: Proposal) => `<li class="d-card d-card-border bg-base-100 helm-proposal">
      <div class="between"><strong>${escapeHtml(kindLabel[p.kind] ?? p.kind)}</strong><span class="muted">${escapeHtml(timeAgo(p.ts))}</span></div>
      <p class="helm-what"><code>${escapeHtml(proposalLine(p))}</code></p>
      <p class="muted">${escapeHtml(p.why)}</p>
      <form class="row shipyard-form" data-api="${api}/${p.id}/apply">
        ${p.kind === "note" ? "" : `<button class="d-btn d-btn-neutral d-btn-sm" type="submit">Apply</button>`}
        <button class="d-btn d-btn-sm" type="submit" data-api="${api}/${p.id}/dismiss">${p.kind === "note" ? "Read" : "Dismiss"}</button>
        <span class="muted" data-note></span>
      </form>
    </li>`;
  const settled = all.filter((p) => p.status !== "open").slice(-3).reverse();
  return `<section class="stack helm">
      <div class="between"><h3>Helm</h3>${
        aboard
          ? `<form class="row shipyard-form" data-api="${api}/review"><button class="d-btn d-btn-sm" type="submit" data-then="note">Ask for a review</button><span class="muted" data-note></span></form>`
          : `<span class="muted">No helmsman aboard</span>`
      }</div>
      ${open.length ? `<ul class="helm-list">${open.map(card).join("")}</ul>` : !aboard ? "" : `<p class="muted">No open proposals. The helmsman reviews the ship's checks, gates, maneuvers, and VM allowlist after each voyage docks.</p>`}
      ${settled.length ? `<p class="muted">Recently: ${settled.map((p) => `${p.status} · ${escapeHtml(proposalLine(p).slice(0, 80))}`).join("; ")}</p>` : ""}
      ${history}
    </section>`;
}

/** The voyage ledger: live for the voyage under sail (with its gates), and past voyages. */
async function ledgerParts(ship: ShipRow, voyage: Voyage | null, labels: Map<string, string>): Promise<{ live: string; past: string }> {
  const label = (id: string) => labels.get(id) ?? id;
  let live = "";
  if (voyage) {
    const gates = await Promise.all((["task", "dock"] as const).filter((st) => ship.gates[st].length).map((st) => gateStatus(ship, st).catch(() => null)));
    live = liveLedgerHtml(voyageId(voyage.file), label, gates.filter((g): g is GateReport => Boolean(g)));
  }
  return { live, past: pastLedgerHtml(ship.id, label) };
}

export async function shipDeckHtml(shipId: string): Promise<string | null> {
  if (shipId === OFFICER_SHIP) return flagshipDeckHtml();
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship) return null;
  const events = recentShipEvents(ship.id, 200);
  const cards = crewCards(ship, events);
  const fm = firstmateCrews(ship);
  const checklist = await shipChecklist(ship);
  const ready = readyToSail(checklist);
  const voyages = await listVoyages(ship.id);
  const voyage = voyages.find((v) => v.status === "sailing") ?? null;
  const st = shipState(ready, voyage, cards, fm);
  const roles = await crewRoles();
  const budgets = Object.fromEntries(await Promise.all(ship.crew.map(async (r) => [r, await crewBudget(ship.id, r)] as const)));
  const labels = new Map(cards.map((c) => [c.target.id, c.target.label]));
  const maneuvers = recentManeuvers(ship.path);
  const tasks = voyage ? listTasks(ship.id, voyage.file) : [];
  const orders = await listOrders();
  const needsYou = cards.some((c) => c.status === "waiting") || orderNeedsCaptain(orders, ship.id);
  const condition = conditionOf({ tasks, maneuvers, events, state: st.state, running: shipRunning(cards, fm), needsYou });
  const cost7d = cards.reduce((n, c) => n + c.cost7d, 0);
  const spendToday = ship.crew.reduce((n, r) => n + spentToday(ship.id, `${ship.id}-${r}`), 0);
  const budget = ship.crew.reduce((sum, r) => sum + (budgets[r] ?? 0), 0);
  const hasBudget = ship.crew.some((r) => budgets[r] !== null);
  const weather = weatherOf({ events, maneuvers, spend: spendToday, budget: hasBudget ? budget : null, state: st.state });
  const factory = ship.adws.length > 0 || maneuvers.length > 0;
  const rows = collapseLog(events);
  const failedRows = rows.slice(0, 80).filter((r) => isBad(r.event)).length;
  // A ship still in the yard needs the shipyard first; once it can sail, the shipyard folds away below the log.
  const yardFirst = !voyage && !ready;
  const yard = shipyardHtml(ship, checklist, roles.map((r) => ({ id: r.id, model: r.model, description: r.description })), budgets, yardFirst, factory);

  return `<div class="ship-deck stack">
    <div class="ship-head between">
      <div class="row">
        <a class="d-btn d-btn-sm" href="/harbor" data-harbor>← Harbor</a>
        <div>
          <h3 class="ship-name">${escapeHtml(ship.id)}</h3>
          <p class="muted path">${escapeHtml(ship.path)}</p>
        </div>
      </div>
      <div class="row-wrap">
        <span class="d-badge d-badge-outline d-badge-sm weather-badge weather-${weather}">${weatherGlyphHtml(weather, true)}</span>
        <span class="d-badge d-badge-outline d-badge-sm">${st.label}</span>
        <span class="d-badge d-badge-outline d-badge-sm">${escapeHtml(ship.mode || "mode unset")}</span>
        <span class="d-badge d-badge-outline d-badge-sm">Orchestrator: ${escapeHtml(ship.orchestrator)}</span>
        <span class="d-badge d-badge-outline d-badge-sm">7d ${usd(cost7d)}</span>
      </div>
    </div>

    ${supplyGaugeHtml(spendToday, hasBudget ? budget : null)}

    ${voyageHtml(ship, voyage, voyages, ready, cards, await ledgerParts(ship, voyage, labels), tasks, condition, await sailChoice(ship))}

    ${voyageRigHtml(ship)}

    ${voyageMemoryHtml(ship, voyage)}

    <section class="stack">
      <h3>Crew</h3>
      ${cards.length ? `<div class="crew-grid">${cards.map(crewCardHtml).join("")}</div>` : `<p class="muted">No crewmates aboard. Add roles under <code>crew:</code> in fleet/ships/${escapeHtml(ship.id)}.yaml.</p>`}
      ${fm.length ? `<h4>Firstmate crews on this ship</h4><div class="crew-grid">${fm.map(fmCrewHtml).join("")}</div>` : ""}
    </section>

    ${await helmHtml(ship)}

    ${yardFirst ? yard : ""}

    <div class="${factory ? "deck-cols" : "stack"}">
      <section class="stack ship-log-wrap" :class="{ 'only-failed': logFailedOnly }">
        <div class="between">
          <h3 id="ship-log">Ship's log</h3>
          ${failedRows ? `<label class="row log-filter"><input type="checkbox" x-model="logFailedOnly" /> Only failures (${failedRows})</label>` : ""}
        </div>
        ${rows.length ? `<ol class="ship-log">${rows.slice(0, 80).map((r) => logRowHtml(r.event, labels, r.repeats)).join("")}</ol>` : `<p class="muted">Nothing logged yet. Crewmate turns, tools, questions, and costs land here as they happen.</p>`}
        <p class="muted log-none-failed">No failures in the newest rows.</p>
      </section>
      ${
        factory
          ? `<section class="stack">
        <h3>Maneuvers</h3>
        ${maneuvers.length ? maneuvers.map(maneuverHtml).join("") : `<p class="muted">No ADW runs yet. Chains on board: ${ship.adws.map(escapeHtml).join(", ")}.</p>`}
      </section>`
          : ""
      }
    </div>

    ${yardFirst ? "" : yard}
  </div>`;
}

/**
 * Log rows newest first, with a failure the turn reported twice (an error
 * notice, then the failed turn-end carrying the same message) shown once.
 */
export function collapseLog(events: ShipEvent[]): { event: ShipEvent; repeats: number }[] {
  const out: { event: ShipEvent; repeats: number }[] = [];
  // "Turn failed after 3m 8s: 503: Service is too busy. We advise…" and the
  // notice "503: Service is too busy." are the same failure.
  const badText = (e: ShipEvent) => (isBad(e) ? humanizeError(e.summary).replace(/^Turn failed after [^:]+:\s*/, "") : null);
  const same = (a: string | null, b: string | null) => Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
  for (const e of events) {
    const prev = out[out.length - 1];
    const text = badText(e);
    if (prev && text && prev.event.actor === e.actor && same(badText(prev.event), text) && Math.abs(Date.parse(prev.event.ts) - Date.parse(e.ts)) < 5 * 60_000) {
      prev.repeats += 1;
      // Keep the turn-end row: it carries the cost.
      if (e.kind === "turn-end" && prev.event.kind !== "turn-end") prev.event = e;
      continue;
    }
    out.push({ event: e, repeats: 1 });
  }
  return out;
}

function isBad(e: ShipEvent): boolean {
  return Boolean((e.kind === "turn-end" && e.payload?.error) || (e.kind === "notice" && e.payload?.level === "error"));
}

// ---------------------------------------------------------------- fleet orders

const ORDER_LABEL: Record<OrderMeta["status"], string> = {
  queued: "Waiting for your Go",
  approved: "Approved, starting soon",
  running: "Alice is running it",
  "needs-captain": "Paused for you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A running order's progress from the fleet log: the step Alice is on, and whether she paused to answer the captain. */
export function orderProgress(slug: string, total: number, events = recentShipEvents(OFFICER_SHIP, 800)): { step: number; total: number; chatPaused: boolean } {
  const mine = events.filter((e) => e.payload?.order === slug);
  const done = mine.filter((e) => e.kind === "order-step" && e.payload?.ok === true).map((e) => Number(e.payload?.step) || 0);
  const step = Math.min(total, (done.length ? Math.max(...done) : 0) + 1);
  // Newest first: paused for chat when an order-chat comes before any later start.
  const last = mine.find((e) => e.kind === "order-chat" || e.kind === "order-start");
  return { step, total, chatPaused: last?.kind === "order-chat" };
}

/** The fleet deck's orders panel: Go, Retry, Cancel, edit and delete, and what each order did. */
const QUEUE_KIND_LABEL: Record<QueueKind, string> = { "design-session": "Design session", "spec-session": "Spec session", "spec-review": "Spec review", "design-review": "Design review" };

/** A review's state and the captain's two answers (lib/decisions.ts reviewQueueItem). */
export function reviewHtml(i: QueueItem, api: string): string {
  if (i.status !== "queued") return "";
  const answer = (approve: string, changes: string, placeholder: string) => `<div class="row-wrap">
      <form class="shipyard-form" data-api="${api}/approve"><button class="d-btn d-btn-sm d-btn-neutral" type="submit">${approve}</button><span class="muted" data-note></span></form>
      <form class="row shipyard-form" data-api="${api}/changes"><input class="d-input d-input-sm" name="note" placeholder="${placeholder}" /><button class="d-btn d-btn-sm" type="submit">${changes}</button><span class="muted" data-note></span></form>
    </div>`;
  if (i.kind === "spec-review") {
    if (!i.record) return `<p class="muted">Waiting for the architect's draft${i.note ? `; your changes: ${escapeHtml(i.note.slice(0, 200))}` : ""}.</p>`;
    const spec = parseSpec(i.record);
    const path = i.record.replace(/^.*\/fleet\/specs\//, "fleet/specs/");
    const rv = i.review;
    const sev = rv ? Object.entries(rv.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.toLowerCase()}${n === 1 ? "" : "s"}`).join(", ") : "";
    const list = (label: string, items: string[]) => (items.length ? `<p class="muted">${label}</p><ul>${items.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "");
    const review = !rv ? "" : rv.unavailable ? `<p class="muted">not reviewed: ${escapeHtml(rv.unavailable)}</p>` : !rv.rel ? `<p class="muted">Review skipped (small change).</p>` : `${rv.incomplete ? `<p class="muted">review incomplete: ${escapeHtml(rv.incomplete)}</p>` : ""}<p class="muted">Reviewed (${escapeHtml(rv.depth)}): ${escapeHtml(sev || "no findings")} · <a href="/vault/${encodeURI(rv.rel)}">the review</a>${rv.draft_changed ? ` · ${rv.draft_changed} lines changed since review` : ""}</p>${rv.escalations.length ? `<ul>${rv.escalations.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}${list("contested", rv.contested ?? [])}`;
    return `<details class="spec-preview"><summary>Spec <code>${escapeHtml(path)}</code> · ${spec?.criteria.length ?? 0} acceptance criteria${spec?.prototype ? ` · from <code>${escapeHtml(spec.prototype)}</code>` : ""}</summary><ol>${(spec?.criteria ?? []).map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ol></details>${review}${answer("Approve", "Ask for changes", "What to change")}`;
  }
  if (i.kind === "design-review") return answer("Accept as built", "Send to the lead", "Anything to add (optional)");
  return "";
}

/**
 * The captain's decision queue (lib/decision-queue.ts) on the flagship's deck:
 * design and spec sessions with the fleet's designer and architect, and the
 * reviews that follow, in the captain's order. Ships build only what it decided.
 */
async function decisionQueueHtml(): Promise<string> {
  const { open, done } = queueView();
  const ships = (await readShips()).map((s) => s.id);
  const laptop = await laptopSailable();
  const row = (i: QueueItem) => {
    const api = `/api/queue/${encodeURIComponent(i.id)}`;
    const btn = (path: string, label: string, extra = "") => `<form class="shipyard-form" data-api="${api}/${path}"${extra}><button class="d-btn d-btn-sm d-btn-ghost" type="submit">${label}</button></form>`;
    const session = i.kind === "design-session" || i.kind === "spec-session";
    const start = i.status === "queued" && session
      ? laptop.ok
        ? `<form class="shipyard-form" data-api="${api}/start"><button class="d-btn d-btn-sm d-btn-neutral" type="submit">Start</button><span class="muted" data-note></span></form>`
        : `<span class="muted" title="${escapeHtml(laptop.why)}">waits for the laptop</span>`
      : "";
    const where = i.status === "active" ? `<a href="/ships/${encodeURIComponent(i.ship)}">in session on ${escapeHtml(i.ship)}</a>` : escapeHtml(i.ship);
    return `<li class="queue-item is-${i.status}"><div class="between"><span><strong>${escapeHtml(QUEUE_KIND_LABEL[i.kind])}</strong> · ${where} · ${escapeHtml(i.title)}</span><span class="row">${start}${i.status === "queued" ? `${btn("up", "↑")}${btn("down", "↓")}${btn("drop", "Drop", ` data-confirm="Drop this from the queue?"`)}` : ""}</span></div>${i.request ? `<p class="muted">${escapeHtml(i.request.slice(0, 300))}</p>` : ""}${reviewHtml(i, api)}</li>`;
  };
  const kinds = QUEUE_KINDS.filter((k) => k.endsWith("-session")).map((k) => `<option value="${k}">${QUEUE_KIND_LABEL[k]}</option>`).join("");
  return `<section class="stack decision-queue">
    <div class="between"><h3>Decision queue</h3><span class="muted">${open.length} open · sessions run on the laptop${laptop.ok ? "" : ` (${escapeHtml(laptop.why)})`}</span></div>
    ${open.length ? `<ol class="stack-tight queue-list">${open.map(row).join("")}</ol>` : `<p class="muted">Nothing waiting. Add what needs deciding before a ship builds it; chores sail without it.</p>`}
    <form class="stack-tight shipyard-form" data-api="/api/queue">
      <div class="row-wrap">
        <select class="d-select d-select-sm" name="kind">${kinds}</select>
        <select class="d-select d-select-sm" name="ship">${ships.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("")}</select>
        <input class="d-input d-input-sm" name="title" placeholder="What needs deciding (Search page redesign)" required />
      </div>
      <textarea class="d-textarea d-textarea-sm" name="request" rows="2" placeholder="What you want out of it, constraints, examples to look at"></textarea>
      <div class="row"><button class="d-btn d-btn-sm" type="submit">Add to the queue</button><span class="muted" data-note></span></div>
    </form>
    ${done.length ? `<details><summary class="muted">Decided · ${done.length}</summary><ul class="stack-tight">${done.slice(0, 10).map((i) => `<li>${escapeHtml(QUEUE_KIND_LABEL[i.kind])} · ${escapeHtml(i.ship)} · ${escapeHtml(i.title)} <span class="muted">· ${escapeHtml(i.status.replace(/-/g, " "))}${i.record ? ` · <code>${escapeHtml(i.record.replace(/^.*\/fleet\/voyages\//, "vault fleet/voyages/"))}</code>` : ""}</span></li>`).join("")}</ul></details>` : ""}
  </section>`;
}

async function ordersPanelHtml(): Promise<string> {
  const all = (await listOrders()).filter((o) => o.meta);
  const events = recentShipEvents(OFFICER_SHIP, 800);
  const open = all.filter((o) => !["done", "failed", "cancelled"].includes(o.meta!.status));
  const closed = all.filter((o) => ["done", "failed", "cancelled"].includes(o.meta!.status)).slice(0, 5);
  const row = (o: (typeof all)[number]) => {
    const m = o.meta!;
    const api = `/api/orders/${encodeURIComponent(o.slug)}`;
    const hot = m.status === "queued" || m.status === "needs-captain";
    const steps = o.order ? o.order.steps : [];
    const del = `<form class="shipyard-form" data-api="${api}/delete" data-confirm="Delete this order? The note moves to fleet/orders/deleted/."><button class="d-btn d-btn-sm d-btn-ghost" type="submit">Delete</button></form>`;
    const editable = (m.status === "queued" || m.status === "approved") && o.text;
    const edit = editable
      ? `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100 order-edit">
          <summary class="d-collapse-title">Edit</summary>
          <form class="d-collapse-content stack shipyard-form" data-api="${api}/edit">
            <label class="stack-tight">Title <input class="d-input d-input-sm" name="title" required value="${escapeHtml(m.title)}" /></label>
            <label class="stack-tight">Steps <textarea class="d-textarea w-full order-body" name="body" rows="12" spellcheck="false">${escapeHtml(editableBody(o.text))}</textarea></label>
            <div class="row"><button class="d-btn d-btn-neutral d-btn-sm" type="submit">Save</button><span class="muted" data-note></span></div>
          </form>
        </details>`
      : "";
    const progress =
      m.status === "running" && steps.length
        ? (() => {
            const pr = orderProgress(o.slug, steps.length, events);
            const cur = steps.find((s) => s.n === pr.step);
            return `<div class="stack-tight order-progress">
              <p><strong>Step ${pr.step} of ${pr.total}</strong>${cur ? `: <code>${escapeHtml(cur.tool)}</code> ${escapeHtml(Object.entries(cur.args).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 160))}${cur.phase === "acceptance" ? ' <span class="muted">(check)</span>' : ""}` : ""}${pr.chatPaused ? ' <span class="d-badge d-badge-sm d-badge-info d-badge-soft">paused to answer you</span>' : ""}</p>
              <progress class="d-progress d-progress-primary w-full" value="${pr.step - 1}" max="${pr.total}"></progress>
            </div>`;
          })()
        : "";
    const buttons =
      m.status === "queued"
        ? `<form class="row shipyard-form" data-api="${api}/go"><button class="d-btn d-btn-neutral d-btn-sm" type="submit">Go</button><span class="muted" data-note></span></form>
           <form class="shipyard-form" data-api="${api}/cancel" data-confirm="Cancel this order?"><button class="d-btn d-btn-sm" type="submit">Cancel</button></form>`
        : m.status === "needs-captain"
          ? `<form class="row shipyard-form" data-api="${api}/retry"><button class="d-btn d-btn-neutral d-btn-sm" type="submit">Retry from step ${m.resume ?? 1}</button><span class="muted" data-note></span></form>
             <form class="shipyard-form" data-api="${api}/cancel" data-confirm="Cancel this order?"><button class="d-btn d-btn-sm" type="submit">Cancel</button></form>`
          : m.status === "approved"
            ? `<form class="shipyard-form" data-api="${api}/cancel" data-confirm="Cancel this order?"><button class="d-btn d-btn-sm" type="submit">Cancel</button></form>`
            : "";
    const actions = `${buttons}${editable || m.status === "cancelled" ? del : ""}`;
    return `<li class="order-row${hot ? " is-hot" : ""}">
      <div class="between">
        <strong>${escapeHtml(m.title)}</strong>
        <span class="d-badge d-badge-sm ${hot ? "d-badge-error" : m.status === "done" ? "d-badge-success d-badge-soft" : "d-badge-outline"}">${ORDER_LABEL[m.status]}</span>
      </div>
      <p class="muted">${escapeHtml(o.slug)} · by ${escapeHtml(m.submitted_by)} · ship ${escapeHtml(m.ship)} · ${steps.filter((s) => s.phase === "step").length} step(s), ${steps.filter((s) => s.phase === "acceptance").length} check(s)</p>
      ${m.reason ? `<p class="warn">${escapeHtml(m.reason)}</p>` : ""}
      ${
        steps.length && (m.status === "queued" || m.status === "needs-captain")
          ? `<ol class="order-steps">${steps.map((s) => `<li${m.resume && s.n < m.resume ? ' class="is-done"' : ""}><code>${escapeHtml(s.tool)}</code> ${escapeHtml(Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 200))}${s.phase === "acceptance" ? ' <span class="muted">(check)</span>' : ""}</li>`).join("")}</ol>`
          : ""
      }
      ${progress}
      ${actions ? `<div class="row">${actions}</div>` : ""}
      ${edit}
    </li>`;
  };
  const ships = (await readShips()).map((s) => s.id);
  const template = [
    "## Intent",
    "",
    "Why this order exists (context for Alice; she does not act on it).",
    "",
    "## Steps",
    "",
    "1. `ship_tasks` ship=kinwork",
    "   expect: the open voyage and its tasks",
    '2. `fleet_chat` to=kinwork-designer text="Status for the captain, please."',
    "   expect: the message lands in the designer's thread",
    "",
    "## Acceptance",
    "",
    "- `agent_chat_read` agent=kinwork-designer n=3",
    "  expect: the message is in the thread",
  ].join("\n");
  const tools = Object.entries(ORDER_TOOLS)
    .map(([name, t]) => `<code>${escapeHtml(name)}</code>${t.params.length ? ` ${escapeHtml(t.params.join(", "))}` : ""}`)
    .join(" · ");
  const writeForm = `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100 order-write">
      <summary class="d-collapse-title">Write an order</summary>
      <form class="d-collapse-content stack shipyard-form" data-api="/api/orders">
        <div class="form-grid">
          <label class="stack-tight">Title <input class="d-input d-input-sm" name="title" required placeholder="Kinwork status round" /></label>
          <label class="stack-tight">Ship <select class="d-select d-select-sm" name="ship">${ships.map((s) => `<option${s === "fleet" ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select></label>
        </div>
        <label class="stack-tight">Steps <textarea class="d-textarea w-full order-body" name="body" rows="14" spellcheck="false">${escapeHtml(template)}</textarea></label>
        <p class="muted">One fleet tool call per step with literal <code>key=value</code> arguments (quote values with spaces) and an indented <code>expect:</code> line. Tools: ${tools}. Your orders are approved when submitted.</p>
        <div class="row"><button class="d-btn d-btn-sm" type="submit" formnovalidate data-api="/api/orders/check" data-then="note">Check</button><button class="d-btn d-btn-neutral d-btn-sm" type="submit">Submit</button><span class="muted" data-note></span></div>
      </form>
    </details>`;
  return `<section class="voyage stack orders-panel">
    <div class="between"><h3>Orders</h3><span class="muted">Alice runs each exactly as written, after your Go</span></div>
    ${open.length ? `<ul class="order-list">${open.map(row).join("")}</ul>` : `<p class="muted">No open orders. Planners queue them with <code>bin/order new</code>, or write one below; they show here for your Go.</p>`}
    ${writeForm}
    ${closed.length ? `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100"><summary class="d-collapse-title">${closed.length} recent order${closed.length === 1 ? "" : "s"}</summary><div class="d-collapse-content"><ul class="order-list">${closed.map(row).join("")}</ul><p class="muted">Each order's report (steps, evidence, planned vs actual) is at the end of its note in the vault: fleet/orders/.</p></div></details>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- shipyard + voyage

function voyageHtml(ship: ShipRow, voyage: Voyage | null, all: Voyage[], ready: boolean, cards: CrewCard[], ledger: { live: string; past: string }, tasks: VoyageTask[], condition: Condition, sail: SailChoice): string {
  const api = `/api/ships/${encodeURIComponent(ship.id)}`;
  const past = all.filter((v) => v.status === "docked").slice(0, 3);
  // Past voyages with their ledgers (metrics database); the plain list only when it has none.
  const pastHtml = ledger.past
    ? ledger.past
    : past.length
    ? `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100"><summary class="d-collapse-title">${past.length} past voyage${past.length === 1 ? "" : "s"}</summary><ul class="d-collapse-content meter-list">${past
        .map((v) => `<li><span>${escapeHtml(v.goal.slice(0, 140))}</span><span class="muted">${escapeHtml(v.started.slice(0, 10))}</span></li>`)
        .join("")}</ul></details>`
    : "";
  if (voyage?.session) {
    // A design or spec session (lib/sessions.ts): a conversation with the flagship officer, wrapped up instead of docked.
    const title = voyage.session === "design" ? "Design session" : "Spec session";
    return `<section class="voyage is-sailing stack">
      <div class="between"><div class="row"><h3>${title}</h3>${condition === "needs-you" ? `<span class="masthead-flag" aria-hidden="true"></span>` : ""}</div><span class="muted">since ${escapeHtml(new Date(voyage.started).toLocaleString())}</span></div>
      <p class="voyage-goal">${escapeHtml(voyage.goal)}</p>
      <p class="muted">With the fleet's ${escapeHtml(voyage.to)} on the laptop · <a href="?chat=${encodeURIComponent(voyage.to)}" data-chat="${escapeHtml(voyage.to)}">open the conversation</a> · branch <code>${escapeHtml(voyageWorktree(ship.id)?.branch ?? "")}</code> · record: <code>${escapeHtml(voyage.file.replace(/^.*\/fleet\/voyages\//, "vault fleet/voyages/"))}</code></p>
      <form class="row shipyard-form" data-api="${api}/dock" data-confirm="Wrap the session up? The prototype branch is pushed (no pull request), the brief goes into the record, and the stack comes down.">
        <input class="d-input d-input-sm" name="summary" placeholder="What was decided (optional; the brief comes from the session)" />
        <button class="d-btn d-btn-sm" type="submit">Wrap up</button><span class="muted" data-note></span>
      </form>
      ${pastHtml}
    </section>`;
  }
  if (voyage) {
    const to = cards.find((c) => c.target.id === voyage.to)?.target.label ?? voyage.to;
    const wt = voyageWorktree(ship.id);
    const onLaptop = wt?.host === "laptop";
    // New voyages may go to exe.dev, so can one under way on the laptop or the hub (not a Gondolin ship, which needs macOS).
    const canExe = Boolean(wt) && (wt?.host === "laptop" || (wt?.host ?? "local") === "local") && ship.isolation !== "vm" && exeVoyages().on;
    const pausedVm = wt?.host === "vm" && wt.vm && isPaused(wt.vm);
    return `<section class="voyage is-sailing stack">
      <div class="between"><div class="row"><h3>Under sail</h3>${condition === "needs-you" ? `<span class="masthead-flag" aria-hidden="true"></span>` : ""}</div><span class="muted">since ${escapeHtml(new Date(voyage.started).toLocaleString())}</span></div>
      <p class="voyage-goal">${escapeHtml(voyage.goal)}</p>
      ${tasksHtml(tasks, cards, condition)}
      ${ledger.live}
      <p class="muted">Goal sent to ${escapeHtml(to)}${onLaptop ? " · <strong>sailing on the laptop</strong>" : ""}${pausedVm ? " · <strong>paused on exe.dev (resumes on the next crew turn)</strong>" : ""} · record: <code>${escapeHtml(voyage.file.replace(/^.*\/fleet\/voyages\//, "vault fleet/voyages/"))}</code></p>
      ${canExe ? `<form class="row shipyard-form" data-api="${api}/move-exe" data-confirm="Move this voyage to an exe.dev VM? A VM is made first, then the crew stops, the branch is pushed, and the VM carries on from it."><button class="d-btn d-btn-sm" type="submit">Move to exe.dev</button><span class="muted" data-note></span></form>` : ""}
      ${onLaptop && ship.isolation !== "vm" ? `<form class="row shipyard-form" data-api="${api}/move" data-confirm="Move this voyage to the hub? The crew stops, the branch is pushed from the laptop, and the hub carries on from it."><button class="d-btn d-btn-sm" type="submit">Move to hub</button><span class="muted" data-note></span></form>` : ""}
      <form class="row shipyard-form" data-api="${api}/dock">
        <input class="d-input d-input-sm" name="summary" placeholder="How it ended (optional, goes in the voyage record)" />
        <button class="d-btn d-btn-sm" type="submit">Dock</button><span class="muted" data-note></span>
      </form>
      ${pastHtml}
    </section>`;
  }
  // Voyages go to crewmates aboard (officers on the fleet deck are not crew).
  const crewTargets = cards.filter((c) => c.target.ship).map((c) => ({ id: c.target.id, label: c.target.label })).sort((a, b) => Number(b.id.endsWith("-lead")) - Number(a.id.endsWith("-lead")));
  const targets = (ship.orchestrator === "firstmate" ? [{ id: "firstmate", label: "Firstmate" }] : []).concat(crewTargets);
  if (!ready || !targets.length) {
    return `<section class="voyage stack"><h3>Voyage</h3><p class="muted">${ready ? "Bring a crewmate aboard to set sail." : "Finish the required shipyard items below, then set a course."}</p>${pastHtml}</section>`;
  }
  return `<section class="voyage stack">
    <h3>Set a course</h3>
    <form class="stack shipyard-form" data-api="${api}/voyage">
      ${decidedHtml(ship)}
      <textarea class="d-textarea w-full" name="goal" rows="2" placeholder="${ship.orchestrator === "lead" ? "The goal (a spec's title is used when left empty)" : "What should this voyage achieve? e.g. Ship the V4 home page with mobile fixes"}"></textarea>
      <div class="row">
        <label class="row">Send to <select class="d-select d-select-sm" name="to">${targets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("")}</select></label>
        ${sail.show ? `<label class="row">Sail on <select class="d-select d-select-sm" name="on"><option value="hub"${sail.prefer === "hub" ? " selected" : ""}>the hub</option><option value="laptop"${sail.laptop ? "" : " disabled"}${sail.prefer === "laptop" ? " selected" : ""}>the laptop${sail.laptop ? "" : ` (${escapeHtml(sail.why)})`}</option>${sail.exe ? `<option value="exe"${sail.exe.ok ? "" : " disabled"}>an exe.dev VM${sail.exe.ok ? "" : ` (${escapeHtml(sail.exe.why)})`}</option>` : ""}</select></label>` : ""}
        <button class="d-btn d-btn-neutral d-btn-sm" type="submit">Set sail</button><span class="muted" data-note></span>
      </div>
    </form>
    ${pastHtml}
  </section>`;
}

/** What a lead-run voyage builds (D3): an approved spec, or a chore; anything else goes to the Decision queue. */
function decidedHtml(ship: ShipRow): string {
  if (ship.orchestrator !== "lead") return "";
  const specs = listSpecs(ship.id, "approved");
  return `<div class="row-wrap">
      <label class="row">Builds <select class="d-select d-select-sm" name="spec"><option value="">${specs.length ? "a chore (tick below)" : "no approved spec yet"}</option>${specs.map((sp) => `<option value="${escapeHtml(sp.file)}">${escapeHtml(sp.title)} · ${sp.criteria.length} criteria</option>`).join("")}</select></label>
      <label class="row"><input type="checkbox" class="d-checkbox d-checkbox-sm" name="chore" /> Chore (a fix, docs, a small change with no new UI or behaviour)</label>
      <span class="muted">Still to decide? Put it on the flagship's <a href="/ships/fleet">Decision queue</a>.</span>
    </div>`;
}

function checkRow(c: CheckItem): string {
  const mark = c.ok ? "✓" : c.required ? "✗" : "○";
  return `<li class="check ${c.ok ? "is-ok" : c.required ? "is-bad" : "is-optional"}"><span class="check-mark" aria-hidden="true">${mark}</span><span><strong>${escapeHtml(c.item)}</strong>${c.required ? "" : " <span class=\"muted\">(optional)</span>"}<br /><span class="muted">${escapeHtml(c.note)}</span></span></li>`;
}

function shipyardHtml(
  ship: ShipRow,
  checklist: CheckItem[],
  roles: { id: string; model: string; description: string }[],
  budgets: Record<string, number | null>,
  open: boolean,
  factory: boolean,
): string {
  const api = `/api/ships/${encodeURIComponent(ship.id)}`;
  const aboard = ship.crew.map((r) => {
    const id = `${ship.id}-${r}`;
    const spent = spentToday(ship.id, id);
    const budget = budgets[r];
    const model = ship.crewModels[r] ?? roles.find((x) => x.id === r)?.model ?? "";
    return `<li class="crew-row">
      <strong>${escapeHtml(r)}</strong>
      <span class="muted">${escapeHtml(model)}</span>
      <form class="row shipyard-form" data-api="${api}/crew">
        <input type="hidden" name="role" value="${escapeHtml(r)}" />
        <label class="row">Daily $ <input class="d-input d-input-sm budget-field" name="budget" type="number" min="0" step="0.5" value="${budget ?? ""}" placeholder="none" /></label>
        <button class="d-btn d-btn-sm" type="submit">Save</button>
        <span class="muted">today ${usd(spent)}${budget ? ` of ${usd(budget)}` : ""}</span>
        <span class="muted" data-note></span>
      </form>
      <form class="shipyard-form" data-api="${api}/crew" data-confirm="Send ${escapeHtml(r)} ashore? Its session stays on disk.">
        <button class="d-btn d-btn-sm" type="submit" name="remove" value="${escapeHtml(r)}">Ashore</button>
      </form>
    </li>`;
  });
  const available = roles.filter((r) => !ship.crew.includes(r.id));
  return `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100 shipyard"${open ? " open" : ""}>
    <summary class="d-collapse-title">Shipyard · ${checklist.filter((c) => c.required && !c.ok).length ? "not ready" : "ready"} · ${ship.crew.length} aboard</summary>
    <div class="d-collapse-content shipyard-cols">
      <div class="stack">
        <h4>Checklist</h4>
        <ul class="checklist">${checklist.map(checkRow).join("")}</ul>
        ${factory ? "" : `<p class="muted">No factory (SSSF) on this ship, so it runs no maneuvers.</p>`}
        <form class="row shipyard-form" data-api="${api}/orchestrator">
          <label class="row">Voyages run by <select class="d-select d-select-sm" name="orchestrator">
            <option value="firstmate"${ship.orchestrator === "firstmate" ? " selected" : ""}>Firstmate</option>
            <option value="lead"${ship.orchestrator === "lead" ? " selected" : ""}>This ship's crew</option>
          </select></label>
          <button class="d-btn d-btn-sm" type="submit">Save</button><span class="muted" data-note></span>
        </form>
      </div>
      <div class="stack">
        <h4>Crew</h4>
        ${aboard.length ? `<ul class="crew-list">${aboard.join("")}</ul>` : `<p class="muted">Nobody aboard yet.</p>`}
        ${
          available.length
            ? `<form class="stack shipyard-form" data-api="${api}/crew">
          <label class="stack-tight">Bring aboard <select class="d-select d-select-sm" name="add">${available
            .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} · ${escapeHtml(r.model)}</option>`)
            .join("")}</select></label>
          <p class="muted">${available.map((r) => `<strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.description)}`).join("<br />")}</p>
          <div class="row"><button class="d-btn d-btn-neutral d-btn-sm" type="submit">Bring aboard</button><span class="muted" data-note></span></div>
        </form>`
            : `<p class="muted">Every crew role is aboard. New roles: agents/&lt;role&gt;/agent.yaml with <code>crew: true</code>.</p>`
        }
      </div>
    </div>
  </details>`;
}

const TASK_MARK: Record<string, string> = { open: "○", working: "◐", done: "●", blocked: "✗" };

/** A task's status as the deck shows it: an open task says what it waits on, or that it is ready. */
function waitLabel(t: VoyageTask, tasks: VoyageTask[]): string {
  if (t.status !== "open") return t.status;
  const waits = waitingOn(t, tasks);
  return waits.length ? `waiting on ${waits.map((n) => `#${n}`).join(", ")}` : t.assignee ? "open" : t.role ? `ready for the ${t.role}` : "ready to claim";
}

function tasksHtml(tasks: VoyageTask[], cards: CrewCard[], condition: Condition): string {
  if (!tasks.length) return `<p class="muted">No tasks yet. A lead plans the voyage into tasks; without one, the crewmate works the goal directly.</p>`;
  const p = taskProgress(tasks);
  const pct = Math.round((p.done / p.total) * 100);
  const label = (id: string | null) => (id ? cards.find((c) => c.target.id === id)?.target.label ?? id : "unassigned");
  return `<div class="voyage-progress-line"><progress class="d-progress d-progress-primary w-full voyage-progress" value="${p.done}" max="${p.total}" aria-label="Tasks done" title="${pct}%"></progress><span class="ship-condition cond-${condition}">${CONDITION_LABEL[condition]}</span></div>
    <p class="muted">${p.done} of ${p.total} tasks done${p.blocked ? ` · <span class="warn">${p.blocked} blocked</span>` : ""}</p>
    <ol class="voyage-tasks">${tasks
      .map(
        (t) => `<li class="vtask is-${t.status}">
        <span class="vtask-mark" aria-hidden="true">${TASK_MARK[t.status] ?? "○"}</span>
        <span class="stack-tight">
          <span><strong>#${t.id}</strong> ${escapeHtml(t.title)}</span>
          <span class="muted">${t.kind === "maneuver" ? `maneuver <code>${escapeHtml(t.adwId ?? "")}</code>` : escapeHtml(label(t.assignee))} · ${escapeHtml(waitLabel(t, tasks))}${t.note ? ` · ${escapeHtml(plain(t.note).slice(0, 200))}` : ""}</span>
        </span>
      </li>`,
      )
      .join("")}</ol>`;
}
