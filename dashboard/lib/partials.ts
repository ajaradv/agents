import { agentArtPath } from "./agent-art.ts";
import { loadAgents, isOrchestratorOrAssistant } from "./agents.ts";
import { lastBusLine } from "./bus.ts";
import { escapeHtml } from "./quota.ts";
import { resolveAgentStatus } from "./agent-status.ts";
import { HERDR_ATTACH_HINT, isTuiAgent } from "./herdr.ts";
import { chatAllowed } from "./chat.ts";
import { chatTarget } from "./chat-targets.ts";
import { recentShipEvents } from "./ship-log.ts";
import { crewStatus, crewStatusLabel, timeAgo } from "./ship-view.ts";
import type { AgentMeta } from "./agents.ts";
import type { FirstmateWaitStatus } from "./firstmate-status.ts";

function chatBadgeClass(state: string): string {
  switch (state) {
    case "ready":
      return "d-badge-success d-badge-soft";
    case "thinking":
      return "d-badge-warning d-badge-soft";
    case "error":
      return "d-badge-error";
    default:
      return "d-badge-outline";
  }
}

function tuiBadgeClass(state: string): string {
  switch (state) {
    case "open":
      return "d-badge-success d-badge-soft";
    case "starting":
    case "stopping":
      return "d-badge-warning d-badge-soft";
    case "error":
      return "d-badge-error";
    default:
      return "d-badge-outline";
  }
}

function firstmateWaitHtml(wait: FirstmateWaitStatus | undefined): string {
  if (!wait?.waitingOnYou && !wait?.actionableHolds.length) return "";
  const parts: string[] = [];
  if (wait.captainWait) {
    parts.push(
      `<p class="warn">Waiting on you: ${escapeHtml(wait.captainWait.summary)}</p>`,
    );
    if (wait.captainWait.prompt) {
      parts.push(`<p class="muted">${escapeHtml(wait.captainWait.prompt)}</p>`);
    }
  }
  for (const h of wait.actionableHolds.slice(0, 5)) {
    const reason = h.holdReason ? `: ${escapeHtml(h.holdReason)}` : "";
    parts.push(
      `<p class="muted">Hold: ${escapeHtml(h.title || h.id)}${reason}${h.holdAgeDays != null ? ` (${h.holdAgeDays}d)` : ""}</p>`,
    );
  }
  if (!wait.snapshotOk && wait.snapshotError) {
    parts.push(`<p class="muted">${escapeHtml(wait.snapshotError)}</p>`);
  }
  return `<div class="stack">${parts.join("")}</div>`;
}

/** "2m 52s" from milliseconds (public/md.js formatDuration, server side). */
export function formatDuration(ms: number): string {
  const n = Number(ms) || 0;
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function lastTurnHtml(agentId: string, turn: { at: string; status: string; ms: number; error?: string } | null | undefined): string {
  if (!turn) return "";
  const when = new Date(turn.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const summary = `${turn.status === "ok" ? "replied" : turn.status} in ${formatDuration(turn.ms)}, ${when}`;
  const err = turn.error
    ? `<pre>${escapeHtml(turn.error.slice(0, 800))}</pre>`
    : "";
  return `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100">
    <summary class="d-collapse-title">Last chat turn: ${escapeHtml(summary)}</summary><div class="d-collapse-content">
    ${err}
  </div></details>`;
}

/** The model, or "on backup <model>" when the last launch fell back (hover for why). */
function modelCell(id: string, model: string): string {
  const t = chatTarget(id);
  const short = (m: string) => m.replace(/^[a-z]+\//, "");
  return t?.backupModel
    ? `<span class="warn" title="${escapeHtml(`Configured: ${model}. ${t.backupReason ?? ""}`)}">on backup ${escapeHtml(short(t.backupModel))}</span>`
    : escapeHtml(short(model || ""));
}

/** Crewmates as one compact table per ship: who, model, status, last activity, Chat. */
function crewTablesHtml(crew: AgentMeta[]): string {
  const ships = [...new Set(crew.map((a) => a.ship!))].sort();
  if (!ships.length) return "";
  const tables = ships.map((ship) => {
    const events = recentShipEvents(ship, 200);
    const rows = crew
      .filter((a) => a.ship === ship)
      .map((a) => {
        const role = a.id.slice(ship.length + 1);
        const s = crewStatus(a.id, events);
        return `<tr class="is-${s.status}">
          <td><span class="row crew-who"><img class="avatar avatar-sm" src="${agentArtPath(role)}" alt="" width="28" height="28" />${escapeHtml(role)}</span></td>
          <td class="muted">${modelCell(a.id, a.model)}</td>
          <td><span class="crew-status">${escapeHtml(crewStatusLabel(s.status))}</span></td>
          <td class="crew-last">${s.lastAt ? `<span class="muted">${escapeHtml(timeAgo(s.lastAt))}</span> ` : ""}${escapeHtml(s.activity.replace(/[*_`#>]+/g, "").slice(0, 90))}</td>
          <td><button type="button" class="d-btn d-btn-sm" @click="openChat('${escapeHtml(a.id)}')">Chat</button></td>
        </tr>`;
      })
      .join("");
    return `<div class="stack-tight">
      <h4><a class="crew-ship" href="/ships/${encodeURIComponent(ship)}" @click.prevent="openShip('${escapeHtml(ship)}')">${escapeHtml(ship)}</a></h4>
      <div class="table-wrap"><table class="d-table d-table-zebra d-table-sm spend-table crew-table">
        <thead><tr><th>Crewmate</th><th>Model</th><th>Status</th><th>Last</th><th><span class="sr-only">Chat</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  });
  return `<section class="stack"><h3>Crew by ship</h3>${tables.join("")}</section>`;
}

export async function agentsSidebarHtml(): Promise<string> {
  // Crew-only templates (scout) exist only aboard ships, as <ship>-<role>.
  const all = (await loadAgents()).filter((a) => !a.crewOnly);
  const agents = all.filter((a) => !a.ship);
  const rows: string[] = [];
  // Each agent's status (herdr pane checks) at the same time, not one after another.
  const resolved = await Promise.all(agents.map(async (a) => [chatAllowed(a.id) ? await resolveAgentStatus(a.id) : null, await lastBusLine(a.id)] as const));
  for (const [i, a] of agents.entries()) {
    const [status, last] = resolved[i]!;
    const chatBadge = status
      ? `<span class="d-badge d-badge-sm ${chatBadgeClass(status.chatState)}">${escapeHtml(status.chatLabel)}</span>`
      : "";
    const tuiBadge =
      status && isTuiAgent(a.id)
        ? `<span class="d-badge d-badge-sm ${tuiBadgeClass(status.tuiState)}">${escapeHtml(status.tuiLabel)}</span>`
        : "";
    let lastShort = "—";
    if (last) {
      try {
        const o = JSON.parse(last) as { summary?: string; kind?: string };
        lastShort = (o.summary ?? o.kind ?? last).slice(0, 60);
      } catch {
        lastShort = last.slice(0, 60);
      }
    }
    const pending =
      status?.tuiState === "starting" || status?.tuiState === "stopping";
    const tuiControls = isTuiAgent(a.id)
      ? `<div class="row">
            ${
              status?.tuiState === "open"
                ? `<button type="button" class="d-btn d-btn-sm" hx-post="/agents/${escapeHtml(a.id)}/stop" hx-swap="none">Close TUI</button>`
                : `<button type="button" class="d-btn d-btn-sm" ${pending ? "disabled" : ""} hx-post="/agents/${escapeHtml(a.id)}/start" hx-swap="none">${pending ? escapeHtml(status?.tuiLabel ?? "Working…") : "Open TUI"}</button>`
            }
          </div>
          ${status?.tuiMessage && status.tuiState === "error" ? `<p class="warn">${escapeHtml(status.tuiMessage.slice(0, 100))}</p>` : ""}
          ${a.id === "firstmate" ? firstmateWaitHtml(status?.firstmateWait) : ""}
          ${lastTurnHtml(a.id, status?.lastChatTurn)}`
      : "";
    const chatBtn = isOrchestratorOrAssistant(a)
      ? `<button type="button" class="d-btn d-btn-sm" @click="openChat('${escapeHtml(a.id)}')">Chat</button>`
      : "";
    const face = agentArtPath(a.id);
    rows.push(`<li class="d-card d-card-border bg-base-100 agent">
        <div class="between">
          <span class="row agent-head"><img class="avatar" src="${face}" alt="" width="48" height="48" /><span class="sheet-title">${escapeHtml(a.id)}</span></span>
          <span class="row">${chatBadge}${tuiBadge}</span>
        </div>
        ${a.description ? `<p class="agent-desc">${escapeHtml(a.description)}</p>` : ""}
        <p class="muted">${a.model ? modelCell(a.id, a.model) : escapeHtml(a.type)}</p>
        <p class="muted" title="${escapeHtml(last ?? "")}">${escapeHtml(lastShort)}</p>
        ${tuiControls}
        ${chatBtn}
    </li>`);
  }
  return `<section class="stack">
    <div class="between"><h3>Officers</h3><span class="muted">Herdr session fleet · attach: ${escapeHtml(HERDR_ATTACH_HINT)}</span></div>
    <ul class="agent-list officer-grid">${rows.join("")}</ul>
  </section>
  ${crewTablesHtml(all.filter((a) => a.ship))}`;
}
