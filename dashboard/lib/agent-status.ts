import { chatAllowed } from "./chat.ts";
import {
  getHeadlessChatState,
  type LastChatTurn,
} from "./chat-bridge.ts";
import { firstmateTuiReachable } from "./firstmate-chat.ts";
import {
  readFirstmateWaitStatus,
  type FirstmateWaitStatus,
} from "./firstmate-status.ts";
import { getLifecycle, type LifecycleState } from "./lifecycle.ts";
import { agentPaneIsLive, isTuiAgent, HERDR_ATTACH_HINT } from "./herdr.ts";
import { readSession, pidAlive } from "./session.ts";

export type TuiDisplayState = LifecycleState | "stopped";

export type HeadlessDisplayState = "ready" | "unavailable" | "thinking" | "error";

export type AgentStatusView = {
  chatState: HeadlessDisplayState;
  chatLabel: string;
  tuiState: TuiDisplayState;
  tuiLabel: string;
  tuiMessage?: string;
  lastChatTurn?: LastChatTurn | null;
  firstmateWait?: FirstmateWaitStatus;
};

function headlessLabel(state: HeadlessDisplayState, agentId: string): string {
  if (agentId === "firstmate" && state === "ready") return "chat → TUI";
  switch (state) {
    case "ready":
      return "chat ready";
    case "thinking":
      return "chat thinking";
    case "error":
      return "chat error";
    default:
      return "chat unavailable";
  }
}

function tuiLabel(state: TuiDisplayState): string {
  switch (state) {
    case "open":
      return "TUI open";
    case "starting":
      return "TUI starting";
    case "stopping":
      return "TUI stopping";
    case "error":
      return "TUI error";
    default:
      return "TUI off";
  }
}

export async function resolveAgentStatus(agentId: string): Promise<AgentStatusView> {
  const headless = getHeadlessChatState(agentId);
  const lastChatTurn = headless.lastTurn;

  if (!chatAllowed(agentId)) {
    return {
      chatState: "unavailable",
      chatLabel: headlessLabel("unavailable", agentId),
      tuiState: "stopped",
      tuiLabel: tuiLabel("stopped"),
    };
  }

  let chatState: HeadlessDisplayState = headless.thinking
    ? "thinking"
    : headless.lastTurn?.status === "error" || headless.lastTurn?.status === "timeout"
      ? "error"
      : "ready";

  if (agentId === "firstmate") {
    const reachable = await firstmateTuiReachable();
    if (!reachable.ok && !headless.thinking) {
      chatState = "unavailable";
    } else if (reachable.ok && !headless.thinking && chatState !== "error") {
      chatState = "ready";
    }
  } else if (!Bun.which("pi")) {
    chatState = "unavailable";
  }

  let tuiState: TuiDisplayState = "stopped";
  let tuiMessage: string | undefined;
  let firstmateWait: FirstmateWaitStatus | undefined;

  if (isTuiAgent(agentId)) {
    const lc = getLifecycle(agentId);
    const session = await readSession(agentId);
    const pane = await agentPaneIsLive(agentId, session?.pid);
    const pidOnly = Boolean(session?.pid && pidAlive(session.pid) && !pane.live);

    if (pane.live) {
      tuiState = "open";
      tuiMessage = lc?.message ?? `Attach: ${HERDR_ATTACH_HINT} (${pane.paneId})`;
    } else if (pidOnly) {
      tuiState = "open";
      tuiMessage =
        "Firstmate already running (session pid). Attach your terminal — do not Start TUI again.";
    } else if (lc?.state === "starting" || lc?.state === "stopping") {
      tuiState = lc.state;
      tuiMessage = lc.message;
    } else if (lc?.state === "error" && !pane.live && !pidOnly) {
      tuiState = "error";
      tuiMessage = lc.message;
    } else {
      tuiState = "stopped";
      tuiMessage = pane.reason;
    }

    if (agentId === "firstmate") {
      firstmateWait = await readFirstmateWaitStatus();
    }
  }

  return {
    chatState,
    chatLabel: headlessLabel(chatState, agentId),
    tuiState,
    tuiLabel: tuiLabel(tuiState),
    tuiMessage,
    lastChatTurn,
    firstmateWait,
  };
}

/** Legacy single-state for non-chat agents */
export async function resolveDisplayState(
  agentId: string,
): Promise<{ state: TuiDisplayState | "stale"; message?: string }> {
  if (chatAllowed(agentId) && isTuiAgent(agentId)) {
    const v = await resolveAgentStatus(agentId);
    return {
      state: v.tuiState,
      message: v.tuiMessage,
    };
  }
  const session = await readSession(agentId);
  if (session?.pid && pidAlive(session.pid)) {
    return { state: "open", message: getLifecycle(agentId)?.message };
  }
  if (session?.pid) {
    return { state: "stale", message: "Process ended; session file may be stale" };
  }
  return { state: "stopped", message: getLifecycle(agentId)?.message };
}
