import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentArtOrNull, pickPoolArt, poolArt, poolFor } from "./agent-art.ts";
import { loadAgents } from "./agents.ts";
import { runFleetSnapshotJson } from "./fleet-snapshot.ts";
import { dashLog } from "./log.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Who the rail can talk to.
 * - headless: registered assistant, one `bin/launch headless` turn per message
 * - firstmate: the one Firstmate TUI, via fm-send
 * - task: a live Firstmate worker, via fm-send <task-id>
 */
export type ChatTargetKind = "headless" | "firstmate" | "task";

export type ChatTarget = {
  id: string;
  kind: ChatTargetKind;
  label: string;
  art: string | null;
  model?: string;
  description?: string;
  /** Seconds one dashboard turn may run (agent.yaml `turn_timeout:`). */
  turnTimeoutSec?: number;
  /** "rpc": a live Pi session in the dashboard's agent host (lib/agent-host.ts). */
  runtime?: "headless" | "rpc";
  /** Shares one Pi session across turns and the TUI; New session starts a fresh one. */
  persistentSession?: boolean;
  /** Task role on the rail: crew or secondmate. */
  role?: "crew" | "secondmate";
  state?: string;
  project?: string;
};

/** Thread ids double as fleet/inbox/<id>/ folder names. */
export const CHAT_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Marker that says a fleet/inbox/<id>/ folder belongs to a worker thread. */
export const TASK_MARKER = ".task";

const TERMINAL = new Set(["done", "failed"]);
const REFRESH_MS = 20_000;

let agents: ChatTarget[] = [];
let tasks: ChatTarget[] = [];
/** Task id -> pool portrait, kept for the task's life so faces do not reshuffle. */
const taskArt = new Map<string, string>();

export function listChatTargets(): { agents: ChatTarget[]; workers: ChatTarget[] } {
  return { agents: [...agents], workers: [...tasks] };
}

export function chatTarget(id: string): ChatTarget | undefined {
  return agents.find((t) => t.id === id) ?? tasks.find((t) => t.id === id);
}

export function chatAllowed(id: string): boolean {
  return CHAT_ID_RE.test(id) && Boolean(chatTarget(id));
}

export function allChatTargetIds(): string[] {
  return [...agents, ...tasks].map((t) => t.id);
}

async function refreshAgents(): Promise<void> {
  const rows = await loadAgents();
  agents = rows
    .filter((a) => CHAT_ID_RE.test(a.id))
    .filter((a) => a.type === "assistant" || a.id === "firstmate")
    .map((a) => ({
      id: a.id,
      kind: a.id === "firstmate" ? "firstmate" : "headless",
      label: a.id,
      art: agentArtOrNull(a.id),
      model: a.model,
      description: a.description,
      turnTimeoutSec: a.turnTimeoutSec || undefined,
      runtime: a.runtime,
      persistentSession: a.persistentSession || undefined,
    }));
}

/** Returns false when the snapshot failed, so callers never archive on a blind read. */
async function refreshTasks(): Promise<boolean> {
  const snap = await runFleetSnapshotJson();
  if (!snap.ok) return false;
  const agentIds = new Set(agents.map((a) => a.id));
  const next: ChatTarget[] = [];
  const live = snap.tasks.filter((t) => {
    const id = String(t.id ?? "");
    return CHAT_ID_RE.test(id) && !agentIds.has(id) && !TERMINAL.has(t.current_state?.state ?? "unknown");
  });
  const liveIds = new Set(live.map((t) => String(t.id)));
  for (const id of [...taskArt.keys()]) if (!liveIds.has(id)) taskArt.delete(id);
  const taken = new Set(taskArt.values());
  for (const t of live) {
    const id = String(t.id);
    const state = t.current_state?.state ?? "unknown";
    let art = taskArt.get(id) ?? null;
    if (!art) {
      art = pickPoolArt(id, poolArt(poolFor(t.kind)), taken);
      if (art) {
        taskArt.set(id, art);
        taken.add(art);
      }
    }
    next.push({
      id,
      kind: "task",
      label: t.backlog?.title ?? t.title ?? id,
      art,
      role: t.kind === "secondmate" ? "secondmate" : "crew",
      state,
      project: t.backlog?.repo ?? t.project,
    });
  }
  tasks = next;
  return true;
}

/** Mark a folder as a worker thread so it can be archived when the task ends. */
export async function markTaskThread(id: string): Promise<void> {
  const dir = join(fleetInboxRoot(), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, TASK_MARKER), new Date().toISOString() + "\n", "utf8");
}

/**
 * Move worker threads whose task has landed or retired to fleet/inbox/archive/.
 * Only folders carrying the .task marker are touched.
 */
export async function archiveEndedTaskThreads(liveIds: Set<string>): Promise<string[]> {
  const root = fleetInboxRoot();
  const moved: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return moved;
  }
  for (const name of names) {
    if (name === "archive" || liveIds.has(name) || !CHAT_ID_RE.test(name)) continue;
    try {
      await stat(join(root, name, TASK_MARKER));
    } catch {
      continue;
    }
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(join(root, "archive"), { recursive: true });
    let dest = join(root, "archive", `${name}-${day}`);
    for (let n = 2; ; n++) {
      try {
        await stat(dest);
        dest = join(root, "archive", `${name}-${day}-${n}`);
      } catch {
        break;
      }
    }
    await rename(join(root, name), dest);
    moved.push(name);
  }
  return moved;
}

export async function refreshChatTargets(): Promise<void> {
  try {
    await refreshAgents();
  } catch (e) {
    console.error("[dashboard] chat targets (agents):", e);
  }
  try {
    if (await refreshTasks()) {
      const moved = await archiveEndedTaskThreads(new Set(allChatTargetIds()));
      if (moved.length) await dashLog("chat-archive", moved.join(","));
    }
  } catch (e) {
    console.error("[dashboard] chat targets (tasks):", e);
  }
}

export function startChatTargetRefresh(onChange: () => void): Promise<void> {
  const first = refreshChatTargets();
  setInterval(() => {
    const before = allChatTargetIds().join(",");
    void refreshChatTargets().then(() => {
      if (allChatTargetIds().join(",") !== before) onChange();
    });
  }, REFRESH_MS);
  return first;
}
