import { hostRunning } from "./agent-host.ts";
import { listChatTargets, type ChatTarget } from "./chat-targets.ts";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { escapeHtml } from "./quota.ts";
import { recentManeuvers, type Maneuver } from "./ship-maneuvers.ts";
import { recentShipEvents, shipTurnTotals, type ShipEvent } from "./ship-log.ts";

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

function crewStatus(id: string, events: ShipEvent[]): { status: CrewStatus; activity: string; lastAt: string | null } {
  const mine = events.filter((e) => e.actor === id);
  const last = mine[0];
  if (hostRunning(id)) {
    const tool = mine.find((e) => e.kind === "tool");
    return { status: "working", activity: tool?.summary ?? "Thinking", lastAt: last?.ts ?? null };
  }
  // Waiting: its newest line is a question the captain has not answered since.
  const question = mine.find((e) => e.kind === "question");
  if (question) {
    const answered = events.some((e) => e.actor === "captain" && (e.kind === "answer" || e.kind === "chat-in") && e.ts > question.ts);
    if (!answered) return { status: "waiting", activity: question.summary, lastAt: question.ts };
  }
  if (!last) return { status: "asleep", activity: "Not started on this ship yet", lastAt: null };
  const said = mine.find((e) => e.kind === "chat-out");
  return { status: "idle", activity: said?.summary ?? last.summary, lastAt: last.ts };
}

function crewCards(ship: ShipRow, events: ShipEvent[]): CrewCard[] {
  const totals = shipTurnTotals(ship.id, new Date(Date.now() - 7 * DAY_MS).toISOString());
  return listChatTargets()
    .agents.filter((t) => t.ship === ship.id)
    .map((target) => {
      const s = crewStatus(target.id, events);
      const t = totals[target.id];
      return { target, ...s, cost7d: t?.cost ?? 0, turns7d: t?.turns ?? 0, errors7d: t?.errors ?? 0 };
    });
}

function firstmateCrews(ship: ShipRow): ChatTarget[] {
  return listChatTargets().workers.filter((w) => (w.project ?? "").toLowerCase() === ship.id.toLowerCase());
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function usd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
}

const STATUS_LABEL: Record<CrewStatus, string> = { working: "Working", waiting: "Needs you", idle: "Idle", asleep: "Not aboard yet" };

function portrait(t: ChatTarget, size = 56): string {
  return t.art
    ? `<img class="portrait" src="${escapeHtml(t.art)}" width="${size}" height="${size}" alt="" />`
    : `<span class="portrait portrait-initials" style="width:${size}px;height:${size}px">${escapeHtml(t.label.slice(0, 2).toUpperCase())}</span>`;
}

/** Ship state for the harbor: in the yard (no crew), sailing (someone working), docked. */
function shipState(cards: CrewCard[], fmCrews: ChatTarget[]): { state: "yard" | "sailing" | "docked"; label: string } {
  if (!cards.length && !fmCrews.length) return { state: "yard", label: "In the yard" };
  if (cards.some((c) => c.status === "working") || fmCrews.some((w) => /work|run|busy|active|spawn|build/i.test(w.state ?? ""))) {
    return { state: "sailing", label: "Under sail" };
  }
  return { state: "docked", label: "Docked" };
}

// ---------------------------------------------------------------- harbor

export async function harborHtml(): Promise<string> {
  const ships = await readShips();
  if (!ships.length) return `<p class="muted">No ships yet. Register one with bin/stamp-ship.</p>`;
  const tiles = ships.map((ship) => {
    const events = recentShipEvents(ship.id, 200);
    const cards = crewCards(ship, events);
    const fm = firstmateCrews(ship);
    const st = shipState(cards, fm);
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
        <div class="ship-deck-faces">${deck.length ? deck.map((t) => portrait(t, 36)).join("") : `<span class="muted">No crew aboard</span>`}</div>
      </div>
    </a>`;
  });
  return `<div class="harbor">${tiles.join("")}</div>`;
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
      <p class="crew-activity">${escapeHtml(c.activity.slice(0, 220))}</p>
      <p class="muted crew-meta">${escapeHtml(t.model ?? "")}${c.lastAt ? ` · ${ago(c.lastAt)}` : ""} · 7d ${usd(c.cost7d)} over ${c.turns7d} turn${c.turns7d === 1 ? "" : "s"}${c.errors7d ? ` · <span class="warn">${c.errors7d} failed</span>` : ""}</p>
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
};

function logRowHtml(e: ShipEvent, labels: Map<string, string>): string {
  const failed = e.kind === "turn-end" && e.payload?.error;
  const cost = e.kind === "turn-end" && typeof e.payload?.cost === "number" && e.payload.cost > 0 ? ` · ${usd(e.payload.cost as number)}` : "";
  const cls = failed || (e.kind === "notice" && e.payload?.level === "error") ? " is-bad" : e.kind === "question" ? " is-ask" : "";
  const who = e.actor === "captain" ? "Captain" : labels.get(e.actor) ?? e.actor;
  const text = e.kind === "turn-start" ? "" : e.summary;
  return `<li class="log-row kind-${escapeHtml(e.kind)}${cls}">
    <time datetime="${escapeHtml(e.ts)}" title="${escapeHtml(e.ts)}">${escapeHtml(new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time>
    <span class="log-who">${escapeHtml(who)}</span>
    <span class="log-kind">${escapeHtml(KIND_LABEL[e.kind] ?? e.kind)}${cost}</span>
    <span class="log-text">${escapeHtml(text.slice(0, 400))}</span>
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
  const st = shipState(cards, fm);
  const labels = new Map(cards.map((c) => [c.target.id, c.target.label]));
  const maneuvers = recentManeuvers(ship.path);
  const cost7d = cards.reduce((n, c) => n + c.cost7d, 0);

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

    <section class="stack">
      <h3>Crew</h3>
      ${cards.length ? `<div class="crew-grid">${cards.map(crewCardHtml).join("")}</div>` : `<p class="muted">No crewmates aboard. Add roles under <code>crew:</code> in fleet/ships/${escapeHtml(ship.id)}.yaml.</p>`}
      ${fm.length ? `<h4>Firstmate crews on this ship</h4><div class="crew-grid">${fm.map(fmCrewHtml).join("")}</div>` : ""}
    </section>

    <div class="deck-cols">
      <section class="stack">
        <h3>Ship's log</h3>
        ${events.length ? `<ol class="ship-log">${events.slice(0, 80).map((e) => logRowHtml(e, labels)).join("")}</ol>` : `<p class="muted">Nothing logged yet. Crewmate turns, tools, questions, and costs land here as they happen.</p>`}
      </section>
      <section class="stack">
        <h3>Maneuvers</h3>
        ${maneuvers.length ? maneuvers.map(maneuverHtml).join("") : ship.adws.length ? `<p class="muted">No ADW runs yet. Chains on board: ${ship.adws.map(escapeHtml).join(", ")}.</p>` : `<p class="muted">No factory on this ship.</p>`}
      </section>
    </div>
  </div>`;
}
