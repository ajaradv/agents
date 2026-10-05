import { agentArtPath } from "./agent-art.ts";
import { loadAgents, isOrchestratorOrAssistant } from "./agents.ts";
import { lastBusLine } from "./bus.ts";
import { escapeHtml } from "./quota.ts";
import { resolveAgentStatus } from "./agent-status.ts";
import { HERDR_ATTACH_HINT, isTuiAgent } from "./herdr.ts";
import { chatAllowed } from "./chat.ts";
import type { FirstmateWaitStatus } from "./firstmate-status.ts";

function chatBadgeClass(state: string): string {
  switch (state) {
    case "ready":
      return "detent-ok";
    case "thinking":
      return "detent-warn";
    case "error":
      return "detent-hot";
    default:
      return "";
  }
}

function tuiBadgeClass(state: string): string {
  switch (state) {
    case "open":
      return "detent-ok";
    case "starting":
    case "stopping":
      return "detent-warn";
    case "error":
      return "detent-hot";
    default:
      return "";
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
    parts.push(
      `<p class="muted">Hold: ${escapeHtml(h.title || h.id)}${h.holdAgeDays != null ? ` (${h.holdAgeDays}d)` : ""}</p>`,
    );
  }
  if (!wait.snapshotOk && wait.snapshotError) {
    parts.push(`<p class="muted">${escapeHtml(wait.snapshotError)}</p>`);
  }
  return `<div class="stack">${parts.join("")}</div>`;
}

function lastTurnHtml(agentId: string, turn: { at: string; status: string; ms: number; error?: string } | null | undefined): string {
  if (!turn) return "";
  const summary = `${turn.status} · ${turn.ms}ms · ${new Date(turn.at).toLocaleString()}`;
  const err = turn.error
    ? `<pre>${escapeHtml(turn.error.slice(0, 800))}</pre>`
    : "";
  return `<details class="fold">
    <summary>Last chat turn: ${escapeHtml(summary)}</summary>
    ${err}
  </details>`;
}

export async function agentsSidebarHtml(): Promise<string> {
  const agents = await loadAgents();
  const rows: string[] = [];
  for (const a of agents) {
    const status = chatAllowed(a.id) ? await resolveAgentStatus(a.id) : null;
    const chatBadge = status
      ? `<span class="detent ${chatBadgeClass(status.chatState)}">${escapeHtml(status.chatLabel)}</span>`
      : "";
    const tuiBadge =
      status && isTuiAgent(a.id)
        ? `<span class="detent ${tuiBadgeClass(status.tuiState)}">${escapeHtml(status.tuiLabel)}</span>`
        : "";
    const last = await lastBusLine(a.id);
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
            <button type="button" class="btn btn-ink" ${pending ? "disabled" : ""} hx-post="/agents/${escapeHtml(a.id)}/start" hx-swap="none">Start TUI</button>
            <button type="button" class="btn" ${pending ? "disabled" : ""} hx-post="/agents/${escapeHtml(a.id)}/stop" hx-swap="none">Stop TUI</button>
          </div>
          ${status?.tuiMessage && status.tuiState === "error" ? `<p class="warn">${escapeHtml(status.tuiMessage.slice(0, 100))}</p>` : ""}
          ${a.id === "firstmate" ? firstmateWaitHtml(status?.firstmateWait) : ""}
          ${lastTurnHtml(a.id, status?.lastChatTurn)}`
      : "";
    const chatBtn = isOrchestratorOrAssistant(a)
      ? `<button type="button" class="btn" @click="selectAgent('${escapeHtml(a.id)}')">Open space</button>`
      : "";
    const face = agentArtPath(a.id);
    rows.push(`<li class="agent">
        <div class="between">
          <span class="row agent-head"><img class="avatar" src="${face}" alt="" width="48" height="48" /><span class="sheet-title">${escapeHtml(a.id)}</span></span>
          <span class="row">${chatBadge}${tuiBadge}</span>
        </div>
        <p class="muted">${escapeHtml(a.model || a.type)}</p>
        <p class="muted" title="${escapeHtml(last ?? "")}">${escapeHtml(lastShort)}</p>
        ${tuiControls}
        ${chatBtn}
    </li>`);
  }
  return `<p class="muted">Herdr session fleet. Attach: ${escapeHtml(HERDR_ATTACH_HINT)}</p><ul class="agent-list">${rows.join("")}</ul>`;
}

export async function agentSpaceHtml(agentId: string): Promise<string> {
  const agents = await loadAgents();
  const a = agents.find((x) => x.id === agentId);
  if (!a || !isOrchestratorOrAssistant(a)) {
    return `<p class="muted">Select an orchestrator agent.</p>`;
  }
  const status = chatAllowed(agentId) ? await resolveAgentStatus(agentId) : null;
  const memory =
    agentId === "alice" || agentId === "architect"
      ? "Hermes (pi-hermes-memory)"
      : "—";
  const face = agentArtPath(agentId);
  return `<article class="sheet stack">
      <div class="row agent-head">
        <img class="portrait" src="${face}" alt="" width="64" height="64" />
        <h3 class="sheet-title">${escapeHtml(agentId)}</h3>
      </div>
      <p class="row">
        <span class="muted">Model ${escapeHtml(a.model)}</span>
        ${status ? `<span class="detent ${chatBadgeClass(status.chatState)}">${escapeHtml(status.chatLabel)}</span>` : ""}
        ${status && isTuiAgent(agentId) ? `<span class="detent ${tuiBadgeClass(status.tuiState)}">${escapeHtml(status.tuiLabel)}</span>` : ""}
      </p>
      ${status?.tuiMessage ? `<p class="muted">${escapeHtml(status.tuiMessage)}</p>` : ""}
      <p class="muted">Memory: ${escapeHtml(memory)}</p>
      ${agentId === "firstmate" ? firstmateWaitHtml(status?.firstmateWait) : ""}
      ${lastTurnHtml(agentId, status?.lastChatTurn)}
      ${
        agentId !== "alice"
          ? `<div id="space-chat-${escapeHtml(agentId)}" x-data="spaceChat('${escapeHtml(agentId)}')">
        <div class="log" x-ref="log"></div>
        <p class="warn" x-show="thinking">thinking…</p>
        <form class="composer" @submit.prevent="send">
          <input class="field" x-model="draft" placeholder="Message ${escapeHtml(agentId)}" aria-label="Message ${escapeHtml(agentId)}" />
          <button class="btn btn-ink" type="submit">Send</button>
        </form>
      </div>`
          : `<p class="muted">Alice chat opens from the right. Optional TUI: ${escapeHtml(HERDR_ATTACH_HINT)}</p>`
      }
    </article>`;
}
