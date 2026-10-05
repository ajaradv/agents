import { join } from "node:path";
import { readSession, pidAlive } from "./session.ts";
import { setLifecycle } from "./lifecycle.ts";
import {
  FLEET_HERDR_SESSION,
  HERDR_ATTACH_HINT,
  TUI_AGENT_IDS,
  agentPaneIsLive,
  clearRuntime,
  ensureAgentWorkspace,
  ensureHerdrServer,
  fleetWorkspaceLabel,
  herdrAvailable,
  invalidateWorkspaceCache,
  isTuiAgent,
  paneRunShell,
  writeRuntime,
} from "./herdr.ts";
import { ROOT } from "./paths.ts";
import { pauseQuotaUntil } from "./quota.ts";
import { dashLog } from "./log.ts";

export type AgentControlResult = {
  ok: boolean;
  status: string;
  message: string;
};

const startJobs = new Map<string, Promise<void>>();
const stopJobs = new Map<string, Promise<void>>();

export type LifecycleEmitter = () => void;

let emitLifecycle: LifecycleEmitter = () => {};

export function setLifecycleEmitter(fn: LifecycleEmitter): void {
  emitLifecycle = fn;
}

export async function agentTuiIsLive(agentId: string): Promise<boolean> {
  const session = await readSession(agentId);
  return (await agentPaneIsLive(agentId, session?.pid)).live;
}

function runStartJob(agentId: string): Promise<void> {
  return (async () => {
    const label = fleetWorkspaceLabel(agentId);
    try {
      pauseQuotaUntil(30_000);
      invalidateWorkspaceCache(agentId);
      await dashLog(`${agentId}-start`, "begin");

      const sessionBefore = await readSession(agentId);
      if (await agentTuiIsLive(agentId)) {
        setLifecycle(agentId, "open", `${agentId} TUI — attach: ${HERDR_ATTACH_HINT}`);
        return;
      }

      if (sessionBefore?.pid && pidAlive(sessionBefore.pid)) {
        await dashLog(
          `${agentId}-start`,
          `existing pid ${sessionBefore.pid}; not starting a second ${agentId}`,
        );
        setLifecycle(
          agentId,
          "open",
          `${agentId} already running (pid ${sessionBefore.pid}). Attach your terminal — only one TUI.`,
        );
        return;
      }

      await ensureHerdrServer(FLEET_HERDR_SESSION);
      const { workspaceId, paneId } = await ensureAgentWorkspace(agentId);
      await writeRuntime(agentId, {
        backend: "herdr",
        herdr_session: FLEET_HERDR_SESSION,
        herdr_workspace_id: workspaceId,
        herdr_pane_id: paneId,
      });

      const launch = join(ROOT, "bin/launch");
      const shellCommand =
        `export FLEET_HERDR_SESSION=${FLEET_HERDR_SESSION} ` +
        `FLEET_HERDR_WORKSPACE_ID=${workspaceId} ` +
        `FLEET_HERDR_PANE_ID=${paneId}; ` +
        `${launch} ${agentId}`;

      await paneRunShell(paneId, shellCommand);

      for (let i = 0; i < 40; i++) {
        await Bun.sleep(500);
        invalidateWorkspaceCache(agentId);
        const s = await readSession(agentId);
        const pane = await agentPaneIsLive(agentId, s?.pid);
        if (pane.live) {
          setLifecycle(
            agentId,
            "open",
            `${agentId} in Herdr "${FLEET_HERDR_SESSION}" workspace "${label}". Attach: ${HERDR_ATTACH_HINT}`,
          );
          await dashLog(`${agentId}-start`, `open pid=${s?.pid ?? "pane"}`);
          return;
        }
      }
      setLifecycle(
        agentId,
        "error",
        `Launch sent in Herdr but Pi did not start. Attach ${HERDR_ATTACH_HINT} and check "${label}".`,
      );
      await dashLog(`${agentId}-start`, "timeout waiting for Pi in pane");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Start failed";
      setLifecycle(agentId, "error", msg);
      await dashLog(`${agentId}-start`, `error ${msg}`);
    } finally {
      invalidateWorkspaceCache(agentId);
      startJobs.delete(agentId);
      emitLifecycle();
    }
  })();
}

export function startAgentTui(agentId: string): AgentControlResult {
  if (!isTuiAgent(agentId)) {
    return { ok: false, status: "error", message: "TUI start not supported for this agent" };
  }
  if (!herdrAvailable()) {
    setLifecycle(agentId, "error", "Install herdr (herdr.dev) and ensure it is on PATH");
    emitLifecycle();
    return { ok: false, status: "error", message: "herdr not on PATH" };
  }
  if (startJobs.has(agentId)) {
    return { ok: true, status: "starting", message: "Start already in progress" };
  }

  const label = fleetWorkspaceLabel(agentId);
  setLifecycle(agentId, "starting", `Starting Herdr workspace ${label}…`);
  emitLifecycle();

  startJobs.set(
    agentId,
    runStartJob(agentId).catch((e) => {
      console.error(`[dashboard] ${agentId} start job failed:`, e);
      setLifecycle(agentId, "error", e instanceof Error ? e.message : "Start failed");
      startJobs.delete(agentId);
      emitLifecycle();
    }) as Promise<void>,
  );

  return {
    ok: true,
    status: "starting",
    message: `Starting ${agentId} (Herdr session ${FLEET_HERDR_SESSION})…`,
  };
}

function runStopJob(agentId: string): Promise<void> {
  return (async () => {
    try {
      invalidateWorkspaceCache(agentId);
      await dashLog(`${agentId}-stop`, "begin");
      const session = await readSession(agentId);
      if (session?.pid && pidAlive(session.pid)) {
        try {
          process.kill(session.pid, "SIGTERM");
        } catch {
          /* gone */
        }
        await Bun.sleep(800);
      }
      await clearRuntime(agentId);
      setLifecycle(
        agentId,
        "stopped",
        `TUI stopped. Workspace may still be visible after: ${HERDR_ATTACH_HINT}`,
      );
      await dashLog(`${agentId}-stop`, "done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stop failed";
      setLifecycle(agentId, "error", msg);
      await dashLog(`${agentId}-stop`, `error ${msg}`);
    } finally {
      invalidateWorkspaceCache(agentId);
      stopJobs.delete(agentId);
      emitLifecycle();
    }
  })();
}

export function stopAgentTui(agentId: string): AgentControlResult {
  if (!isTuiAgent(agentId)) {
    return { ok: false, status: "error", message: "TUI stop not supported for this agent" };
  }
  if (stopJobs.has(agentId)) {
    return { ok: true, status: "stopping", message: "Stop already in progress" };
  }

  setLifecycle(agentId, "stopping", `Stopping ${agentId} Pi process…`);
  emitLifecycle();

  stopJobs.set(
    agentId,
    runStopJob(agentId).catch((e) => {
      console.error(`[dashboard] ${agentId} stop job failed:`, e);
      setLifecycle(agentId, "error", e instanceof Error ? e.message : "Stop failed");
      stopJobs.delete(agentId);
      emitLifecycle();
    }) as Promise<void>,
  );

  return {
    ok: true,
    status: "stopping",
    message: `Stopping ${agentId}…`,
  };
}

export function startAlice(): AgentControlResult {
  return startAgentTui("alice");
}

export function stopAlice(): AgentControlResult {
  return stopAgentTui("alice");
}

export { TUI_AGENT_IDS };
