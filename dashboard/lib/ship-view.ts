import { hostRunning } from "./node-client.ts";
import { listChatTargets, type ChatTarget } from "./chat-targets.ts";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { humanizeError, plainSummary } from "./humanize.ts";
import { listOrders, ORDER_TOOLS, type OrderMeta } from "./order-note.ts";
import { escapeHtml } from "./quota.ts";
import { recentManeuvers, type Maneuver } from "./ship-maneuvers.ts";
import { recentShipEvents, shipTurnTotals, type ShipEvent } from "./ship-log.ts";
import { listTasks, taskProgress, type VoyageTask } from "./voyage-tasks.ts";
import { crewBudget, crewRoles, listVoyages, MODES, readyToSail, shipChecklist, spentToday, type CheckItem, type Voyage } from "./shipyard.ts";

/**
 * Harbor (every ship) and ship deck (one ship) partials. Read-only: crew status
 * comes from the agent host and the ship's log, maneuvers from the ship's
 * sssf.db, Firstmate's crews from the rail's task list.
 */

type CrewStatus = "working" | "waiting" | "idle" | "asleep";

type CrewCard = {
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

function crewCards(ship: ShipRow, events: ShipEvent[]): CrewCard[] {
  const totals = shipTurnTotals(ship.id, new Date(Date.now() - 7 * DAY_MS).toISOString());
  // The fleet ship (this repo) is crewed by the officers: their turns are logged there (lib/ship-events.ts).
  return listChatTargets()
    .agents.filter((t) => t.ship === ship.id || (ship.id === "fleet" && !t.ship && t.kind === "headless"))
    .map((target) => {
      const s = crewStatus(target.id, events);
      const t = totals[target.id];
      return { target, ...s, cost7d: t?.cost ?? 0, turns7d: t?.turns ?? 0, errors7d: t?.errors ?? 0 };
    });
}

function firstmateCrews(ship: ShipRow): ChatTarget[] {
  return listChatTargets().workers.filter((w) => (w.project ?? "").toLowerCase() === ship.id.toLowerCase());
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

const STATUS_LABEL: Record<CrewStatus, string> = { working: "Working", waiting: "Needs you", idle: "Idle", asleep: "Not started" };

function portrait(t: ChatTarget, size = 56): string {
  return t.art
    ? `<img class="portrait" src="${escapeHtml(t.art)}" width="${size}" height="${size}" alt="" />`
    : `<span class="portrait portrait-initials" style="width:${size}px;height:${size}px">${escapeHtml(t.label.slice(0, 2).toUpperCase())}</span>`;
}

/** In the yard (not ready to sail), under sail (open voyage or crew at work), or docked. */
function shipState(ready: boolean, voyage: Voyage | null, cards: CrewCard[], fmCrews: ChatTarget[]): { state: "yard" | "sailing" | "docked"; label: string } {
  if (voyage || cards.some((c) => c.status === "working") || fmCrews.some((w) => /work|run|busy|active|spawn|build/i.test(w.state ?? ""))) {
    return { state: "sailing", label: "Under sail" };
  }
  if (!ready) return { state: "yard", label: "In the yard" };
  return { state: "docked", label: "Docked" };
}

// ---------------------------------------------------------------- harbor

export async function harborHtml(): Promise<string> {
  const ships = await readShips();
  if (!ships.length) return `<p class="muted">No ships yet. Register one with bin/stamp-ship.</p>`;
  const tiles = ships.map(async (ship) => {
    const events = recentShipEvents(ship.id, 200);
    const cards = crewCards(ship, events);
    const fm = firstmateCrews(ship);
    const voyages = await listVoyages(ship.id);
    const voyage = voyages.find((v) => v.status === "sailing") ?? null;
    const st = shipState(readyToSail(await shipChecklist(ship)), voyage, cards, fm);
    const waiting = cards.filter((c) => c.status === "waiting").length;
    const deck = [...cards.map((c) => c.target), ...fm].slice(0, 6);
    return `<a class="ship-tile is-${st.state}" href="/ships/${encodeURIComponent(ship.id)}" data-ship="${escapeHtml(ship.id)}">
      <div class="ship-sprite" aria-hidden="true"><span class="ship-hull"></span><span class="ship-sail"></span><span class="ship-wake"></span></div>
      <div class="stack-tight">
        <div class="between">
          <h3 class="ship-name">${escapeHtml(ship.id)}</h3>
          ${waiting ? `<span class="detent detent-hot">${waiting} need${waiting === 1 ? "s" : ""} you</span>` : `<span class="detent">${st.label}</span>`}
        </div>
        <p class="muted ship-meta">${escapeHtml(ship.orchestrator === "firstmate" ? "Orchestrator: Firstmate" : `Orchestrator: ${ship.orchestrator}`)} · ${escapeHtml(ship.mode || "mode unset")}${ship.adws.length ? ` · ${ship.adws.length} ADWs` : ""}</p>
        ${voyage ? `<p class="ship-voyage">⚑ ${escapeHtml(voyage.goal.slice(0, 120))}</p>` : ""}
        <div class="ship-deck-faces">${deck.length ? deck.map((t) => portrait(t, 36)).join("") : `<span class="muted">No crew aboard</span>`}</div>
      </div>
    </a>`;
  });
  return `<div class="harbor">${(await Promise.all(tiles)).join("")}</div>
  <details class="fold new-ship">
    <summary>Build a new ship</summary>
    <form class="stack shipyard-form" data-api="/api/ships" data-then="ship">
      <div class="form-grid">
        <label class="stack-tight">Ship id <input class="field" name="id" required pattern="[a-z][a-z0-9_-]{0,40}" placeholder="pochteca" /></label>
        <label class="stack-tight">Repo path <input class="field" name="path" required placeholder="/Users/you/Workspace/project" /></label>
        <label class="stack-tight">Delivery mode <select class="field" name="mode">${MODES.map((m) => `<option${m === "no-mistakes" ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="stack-tight">Register with Firstmate (one-line description, optional) <input class="field" name="firstmate" placeholder="Leave empty to run it with its own crew" /></label>
      </div>
      <label class="row"><input type="checkbox" name="factory" /> Install the SSSF factory (writes adws/ and .claude/skills/sssf into the repo)</label>
      <div class="row"><button class="btn btn-ink" type="submit">Lay the keel</button><span class="muted" data-note></span></div>
    </form>
  </details>`;
}

// ---------------------------------------------------------------- ship deck

function crewCardHtml(c: CrewCard): string {
  const t = c.target;
  return `<article class="crew-card is-${c.status}">
    ${portrait(t, 64)}
    <div class="stack-tight crew-body">
      <div class="between">
        <h4 class="sheet-title">${escapeHtml(t.label)}</h4>
        <span class="crew-status">${STATUS_LABEL[c.status]}</span>
      </div>
      <p class="crew-activity">${escapeHtml(plain(c.activity).slice(0, 220))}</p>
      <p class="muted crew-meta">${t.backupModel ? `<span class="warn" title="${escapeHtml(`Configured: ${t.model ?? ""}. ${t.backupReason ?? ""}`)}">on backup ${escapeHtml(t.backupModel)}</span>` : escapeHtml(t.model ?? "")}${c.lastAt ? ` · ${ago(c.lastAt)}` : ""} · 7d ${usd(c.cost7d)} over ${c.turns7d} turn${c.turns7d === 1 ? "" : "s"}${c.errors7d ? ` · <a class="warn" href="#ship-log" @click.prevent="showFailedLog()">${c.errors7d} failed</a>` : ""}</p>
      <div class="row"><a class="btn btn-ink" href="?chat=${encodeURIComponent(t.id)}" data-chat="${escapeHtml(t.id)}">Chat</a></div>
    </div>
  </article>`;
}

function fmCrewHtml(w: ChatTarget): string {
  return `<article class="crew-card is-firstmate">
    ${portrait(w, 48)}
    <div class="stack-tight crew-body">
      <div class="between"><h4>${escapeHtml(w.label)}</h4>${w.state && w.state !== "unknown" ? `<span class="crew-status">${escapeHtml(w.state)}</span>` : ""}</div>
      <p class="muted crew-meta">Firstmate ${escapeHtml(w.role ?? "crew")}</p>
      <div class="row"><a class="btn" href="?chat=${encodeURIComponent(w.id)}" data-chat="${escapeHtml(w.id)}">Chat</a></div>
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
  return `<li class="log-row kind-${escapeHtml(e.kind)}${cls}">
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
  return `<article class="maneuver">
    <div class="between"><h4>${escapeHtml(m.adwName)}</h4><span class="detent${m.status === "fail" ? " detent-hot" : ""}">${escapeHtml(m.status)}</span></div>
    <p class="muted">${escapeHtml(m.request.slice(0, 200))}</p>
    <ol class="phase-chain">${chain || `<li class="muted">No phases recorded</li>`}</ol>
    ${err ? `<p class="warn">${escapeHtml(err.name)}: ${escapeHtml((err.error ?? "").slice(0, 300))}</p>` : ""}
    <p class="muted">${escapeHtml(m.startedAt ? new Date(m.startedAt).toLocaleString() : "")}${m.cost ? ` · ${usd(m.cost)}` : ""} · <code>${escapeHtml(m.adwId)}</code></p>
  </article>`;
}

export async function shipDeckHtml(shipId: string): Promise<string | null> {
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
  const cost7d = cards.reduce((n, c) => n + c.cost7d, 0);
  const factory = ship.adws.length > 0 || maneuvers.length > 0;
  const rows = collapseLog(events);
  const failedRows = rows.slice(0, 80).filter((r) => isBad(r.event)).length;
  // A ship still in the yard needs the shipyard first; once it can sail, the shipyard folds away below the log.
  const yardFirst = !voyage && !ready;
  const yard = shipyardHtml(ship, checklist, roles.map((r) => ({ id: r.id, model: r.model, description: r.description })), budgets, yardFirst, factory);

  return `<div class="ship-deck stack">
    <div class="ship-head between">
      <div class="row">
        <a class="btn" href="/harbor" data-harbor>← Harbor</a>
        <div>
          <h3 class="ship-name">${escapeHtml(ship.id)}</h3>
          <p class="muted path">${escapeHtml(ship.path)}</p>
        </div>
      </div>
      <div class="row-wrap">
        <span class="detent">${st.label}</span>
        <span class="detent">${escapeHtml(ship.mode || "mode unset")}</span>
        <span class="detent">Orchestrator: ${escapeHtml(ship.orchestrator)}</span>
        <span class="detent">7d ${usd(cost7d)}</span>
      </div>
    </div>

    ${ship.id === "fleet" ? await ordersPanelHtml() : voyageHtml(ship, voyage, voyages, ready, cards)}

    <section class="stack">
      <h3>Crew</h3>
      ${cards.length ? `<div class="crew-grid">${cards.map(crewCardHtml).join("")}</div>` : `<p class="muted">No crewmates aboard. Add roles under <code>crew:</code> in fleet/ships/${escapeHtml(ship.id)}.yaml.</p>`}
      ${fm.length ? `<h4>Firstmate crews on this ship</h4><div class="crew-grid">${fm.map(fmCrewHtml).join("")}</div>` : ""}
    </section>

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

/** The fleet deck's orders panel: Go, Retry, Cancel, and what each order did. */
async function ordersPanelHtml(): Promise<string> {
  const all = (await listOrders()).filter((o) => o.meta);
  const open = all.filter((o) => !["done", "failed", "cancelled"].includes(o.meta!.status));
  const closed = all.filter((o) => ["done", "failed", "cancelled"].includes(o.meta!.status)).slice(0, 5);
  const row = (o: (typeof all)[number]) => {
    const m = o.meta!;
    const api = `/api/orders/${encodeURIComponent(o.slug)}`;
    const hot = m.status === "queued" || m.status === "needs-captain";
    const steps = o.order ? o.order.steps : [];
    const buttons =
      m.status === "queued"
        ? `<form class="row shipyard-form" data-api="${api}/go"><button class="btn btn-ink" type="submit">Go</button><span class="muted" data-note></span></form>
           <form class="shipyard-form" data-api="${api}/cancel" data-confirm="Cancel this order?"><button class="btn" type="submit">Cancel</button></form>`
        : m.status === "needs-captain"
          ? `<form class="row shipyard-form" data-api="${api}/retry"><button class="btn btn-ink" type="submit">Retry from step ${m.resume ?? 1}</button><span class="muted" data-note></span></form>
             <form class="shipyard-form" data-api="${api}/cancel" data-confirm="Cancel this order?"><button class="btn" type="submit">Cancel</button></form>`
          : m.status === "approved"
            ? `<form class="shipyard-form" data-api="${api}/cancel" data-confirm="Cancel this order?"><button class="btn" type="submit">Cancel</button></form>`
            : "";
    return `<li class="order-row${hot ? " is-hot" : ""}">
      <div class="between">
        <strong>${escapeHtml(m.title)}</strong>
        <span class="detent${hot ? " detent-hot" : m.status === "done" ? " detent-ok" : ""}">${ORDER_LABEL[m.status]}</span>
      </div>
      <p class="muted">${escapeHtml(o.slug)} · by ${escapeHtml(m.submitted_by)} · ship ${escapeHtml(m.ship)} · ${steps.filter((s) => s.phase === "step").length} step(s), ${steps.filter((s) => s.phase === "acceptance").length} check(s)</p>
      ${m.reason ? `<p class="warn">${escapeHtml(m.reason)}</p>` : ""}
      ${
        steps.length && (m.status === "queued" || m.status === "needs-captain")
          ? `<ol class="order-steps">${steps.map((s) => `<li${m.resume && s.n < m.resume ? ' class="is-done"' : ""}><code>${escapeHtml(s.tool)}</code> ${escapeHtml(Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 200))}${s.phase === "acceptance" ? ' <span class="muted">(check)</span>' : ""}</li>`).join("")}</ol>`
          : ""
      }
      ${buttons ? `<div class="row">${buttons}</div>` : ""}
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
  const writeForm = `<details class="fold order-write">
      <summary>Write an order</summary>
      <form class="stack shipyard-form" data-api="/api/orders">
        <div class="form-grid">
          <label class="stack-tight">Title <input class="field" name="title" required placeholder="Kinwork status round" /></label>
          <label class="stack-tight">Ship <select class="field" name="ship">${ships.map((s) => `<option${s === "fleet" ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select></label>
        </div>
        <label class="stack-tight">Steps <textarea class="field order-body" name="body" rows="14" spellcheck="false">${escapeHtml(template)}</textarea></label>
        <p class="muted">One fleet tool call per step with literal <code>key=value</code> arguments (quote values with spaces) and an indented <code>expect:</code> line. Tools: ${tools}. Your orders are approved when submitted.</p>
        <div class="row"><button class="btn" type="submit" formnovalidate data-api="/api/orders/check" data-then="note">Check</button><button class="btn btn-ink" type="submit">Submit</button><span class="muted" data-note></span></div>
      </form>
    </details>`;
  return `<section class="voyage stack orders-panel">
    <div class="between"><h3>Orders</h3><span class="muted">Alice runs each exactly as written, after your Go</span></div>
    ${open.length ? `<ul class="order-list">${open.map(row).join("")}</ul>` : `<p class="muted">No open orders. Planners queue them with <code>bin/order new</code>, or write one below; they show here for your Go.</p>`}
    ${writeForm}
    ${closed.length ? `<details class="fold"><summary>${closed.length} recent order${closed.length === 1 ? "" : "s"}</summary><ul class="order-list">${closed.map(row).join("")}</ul><p class="muted">Each order's report (steps, evidence, planned vs actual) is at the end of its note in the vault: fleet/orders/.</p></details>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- shipyard + voyage

function voyageHtml(ship: ShipRow, voyage: Voyage | null, all: Voyage[], ready: boolean, cards: CrewCard[]): string {
  const api = `/api/ships/${encodeURIComponent(ship.id)}`;
  const past = all.filter((v) => v.status === "docked").slice(0, 3);
  const pastHtml = past.length
    ? `<details class="fold"><summary>${past.length} past voyage${past.length === 1 ? "" : "s"}</summary><ul class="meter-list">${past
        .map((v) => `<li><span>${escapeHtml(v.goal.slice(0, 140))}</span><span class="muted">${escapeHtml(v.started.slice(0, 10))}</span></li>`)
        .join("")}</ul></details>`
    : "";
  if (voyage) {
    const to = cards.find((c) => c.target.id === voyage.to)?.target.label ?? voyage.to;
    return `<section class="voyage is-sailing stack">
      <div class="between"><h3>Under sail</h3><span class="muted">since ${escapeHtml(new Date(voyage.started).toLocaleString())}</span></div>
      <p class="voyage-goal">${escapeHtml(voyage.goal)}</p>
      ${tasksHtml(listTasks(ship.id, voyage.file), cards)}
      <p class="muted">Goal sent to ${escapeHtml(to)} · record: <code>${escapeHtml(voyage.file.replace(/^.*\/fleet\/voyages\//, "vault fleet/voyages/"))}</code></p>
      <form class="row shipyard-form" data-api="${api}/dock">
        <input class="field" name="summary" placeholder="How it ended (optional, goes in the voyage record)" />
        <button class="btn" type="submit">Dock</button><span class="muted" data-note></span>
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
      <textarea class="field" name="goal" rows="2" required placeholder="What should this voyage achieve? e.g. Ship the V4 home page with mobile fixes"></textarea>
      <div class="row">
        <label class="row">Send to <select class="field" name="to">${targets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("")}</select></label>
        <button class="btn btn-ink" type="submit">Set sail</button><span class="muted" data-note></span>
      </div>
    </form>
    ${pastHtml}
  </section>`;
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
        <label class="row">Daily $ <input class="field budget-field" name="budget" type="number" min="0" step="0.5" value="${budget ?? ""}" placeholder="none" /></label>
        <button class="btn" type="submit">Save</button>
        <span class="muted">today ${usd(spent)}${budget ? ` of ${usd(budget)}` : ""}</span>
        <span class="muted" data-note></span>
      </form>
      <form class="shipyard-form" data-api="${api}/crew" data-confirm="Send ${escapeHtml(r)} ashore? Its session stays on disk.">
        <button class="btn" type="submit" name="remove" value="${escapeHtml(r)}">Ashore</button>
      </form>
    </li>`;
  });
  const available = roles.filter((r) => !ship.crew.includes(r.id));
  return `<details class="fold shipyard"${open ? " open" : ""}>
    <summary>Shipyard · ${checklist.filter((c) => c.required && !c.ok).length ? "not ready" : "ready"} · ${ship.crew.length} aboard</summary>
    <div class="shipyard-cols">
      <div class="stack">
        <h4>Checklist</h4>
        <ul class="checklist">${checklist.map(checkRow).join("")}</ul>
        ${factory ? "" : `<p class="muted">No factory (SSSF) on this ship, so it runs no maneuvers.</p>`}
        <form class="row shipyard-form" data-api="${api}/orchestrator">
          <label class="row">Voyages run by <select class="field" name="orchestrator">
            <option value="firstmate"${ship.orchestrator === "firstmate" ? " selected" : ""}>Firstmate</option>
            <option value="lead"${ship.orchestrator === "lead" ? " selected" : ""}>This ship's crew</option>
          </select></label>
          <button class="btn" type="submit">Save</button><span class="muted" data-note></span>
        </form>
      </div>
      <div class="stack">
        <h4>Crew</h4>
        ${aboard.length ? `<ul class="crew-list">${aboard.join("")}</ul>` : `<p class="muted">Nobody aboard yet.</p>`}
        ${
          available.length
            ? `<form class="stack shipyard-form" data-api="${api}/crew">
          <label class="stack-tight">Bring aboard <select class="field" name="add">${available
            .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} · ${escapeHtml(r.model)}</option>`)
            .join("")}</select></label>
          <p class="muted">${available.map((r) => `<strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.description)}`).join("<br />")}</p>
          <div class="row"><button class="btn btn-ink" type="submit">Bring aboard</button><span class="muted" data-note></span></div>
        </form>`
            : `<p class="muted">Every crew role is aboard. New roles: agents/&lt;role&gt;/agent.yaml with <code>crew: true</code>.</p>`
        }
      </div>
    </div>
  </details>`;
}

const TASK_MARK: Record<string, string> = { open: "○", working: "◐", done: "●", blocked: "✗" };

function tasksHtml(tasks: VoyageTask[], cards: CrewCard[]): string {
  if (!tasks.length) return `<p class="muted">No tasks yet. A lead plans the voyage into tasks; without one, the crewmate works the goal directly.</p>`;
  const p = taskProgress(tasks);
  const pct = Math.round((p.done / p.total) * 100);
  const label = (id: string | null) => (id ? cards.find((c) => c.target.id === id)?.target.label ?? id : "unassigned");
  return `<div class="voyage-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}" aria-label="Tasks done">
      <span style="width:${pct}%"></span>
    </div>
    <p class="muted">${p.done} of ${p.total} tasks done${p.blocked ? ` · <span class="warn">${p.blocked} blocked</span>` : ""}</p>
    <ol class="voyage-tasks">${tasks
      .map(
        (t) => `<li class="vtask is-${t.status}">
        <span class="vtask-mark" aria-hidden="true">${TASK_MARK[t.status] ?? "○"}</span>
        <span class="stack-tight">
          <span><strong>#${t.id}</strong> ${escapeHtml(t.title)}</span>
          <span class="muted">${t.kind === "maneuver" ? `maneuver <code>${escapeHtml(t.adwId ?? "")}</code>` : escapeHtml(label(t.assignee))} · ${escapeHtml(t.status)}${t.note ? ` · ${escapeHtml(plain(t.note).slice(0, 200))}` : ""}</span>
        </span>
      </li>`,
      )
      .join("")}</ol>`;
}
