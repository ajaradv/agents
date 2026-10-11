import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentArtOrNull } from "./agent-art.ts";
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
    }));
}

/** Returns false when the snapshot failed, so callers never archive on a blind read. */
async function refreshTasks(): Promise<boolean> {
  const snap = await runFleetSnapshotJson();
  if (!snap.ok) return false;
  const agentIds = new Set(agents.map((a) => a.id));
  const next: ChatTarget[] = [];
  for (const t of snap.tasks) {
    const id = String(t.id ?? "");
    const state = t.current_state?.state ?? "unknown";
    if (!CHAT_ID_RE.test(id) || agentIds.has(id) || TERMINAL.has(state)) continue;
    next.push({
      id,
      kind: "task",
      label: t.backlog?.title ?? t.title ?? id,
      art: null,
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
