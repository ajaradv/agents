import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";
import { escapeHtml } from "./quota.ts";
import { FM_HOME } from "./firstmate-chat.ts";

export type FleetTaskRow = {
  id: string;
  title: string;
  project: string;
  state: string;
  captainActionable: boolean;
  ageSeconds: number | null;
};

export type FirstmateHeartbeat = {
  ts: string;
  state?: string;
  ageLabel: string;
};

type SnapshotTask = {
  id?: string;
  title?: string;
  project?: string;
  captain_actionable?: boolean;
  current_state?: { state?: string; age_seconds?: number | null };
};

export async function runFleetSnapshotJson(): Promise<{
  ok: boolean;
  error?: string;
  tasks: SnapshotTask[];
}> {
  const snapshotPath = join(FM_HOME, "bin", "fm-fleet-snapshot.sh");
  try {
    const res = await Bun.spawn(["bash", snapshotPath, "--json"], {
      cwd: FM_HOME,
      env: { ...process.env, FM_HOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(res.stdout).text(),
      res.exited,
    ]);
    if (exitCode !== 0) {
      return { ok: false, error: "snapshot unavailable", tasks: [] };
    }
    const j = JSON.parse(stdout) as { tasks?: SnapshotTask[] };
    return { ok: true, tasks: j.tasks ?? [] };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "snapshot failed",
      tasks: [],
    };
  }
}

export async function readLatestFirstmateHeartbeat(): Promise<FirstmateHeartbeat | null> {
  try {
    const raw = await readFile(
      join(fleetInboxRoot(), "firstmate", "events.jsonl"),
      "utf8",
    );
    let last: FirstmateHeartbeat | null = null;
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as {
          kind?: string;
          from?: string;
          ts?: string;
          state?: string;
        };
        if (o.kind === "heartbeat" && o.from === "firstmate" && o.ts) {
          last = {
            ts: o.ts,
            state: o.state,
            ageLabel: formatAge(Date.parse(o.ts)),
          };
        }
      } catch {
        continue;
      }
    }
    if (last) {
      last.ageLabel = formatAge(Date.parse(last.ts));
    }
    return last;
  } catch {
    return null;
  }
}

function formatAge(tsMs: number): string {
  if (Number.isNaN(tsMs)) return "unknown";
  const sec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function activeTasks(tasks: SnapshotTask[]): FleetTaskRow[] {
  const terminal = new Set(["done", "failed"]);
  const rows: FleetTaskRow[] = [];
  for (const t of tasks) {
    const state = t.current_state?.state ?? "unknown";
    if (terminal.has(state)) continue;
    rows.push({
      id: String(t.id ?? ""),
      title: String(t.title ?? t.id ?? "task"),
      project: String(t.project ?? "").trim() || "(no project)",
      state,
      captainActionable: Boolean(t.captain_actionable),
      ageSeconds:
        t.current_state?.age_seconds === null ||
        t.current_state?.age_seconds === undefined
          ? null
          : Number(t.current_state.age_seconds),
    });
  }
  rows.sort((a, b) => {
    if (a.captainActionable !== b.captainActionable) {
      return a.captainActionable ? -1 : 1;
    }
    return a.project.localeCompare(b.project) || a.id.localeCompare(b.id);
  });
  return rows;
}

function groupByProject(rows: FleetTaskRow[]): Map<string, FleetTaskRow[]> {
  const map = new Map<string, FleetTaskRow[]>();
  for (const r of rows) {
    const list = map.get(r.project) ?? [];
    list.push(r);
    map.set(r.project, list);
  }
  return map;
}

export async function fleetStripHtml(): Promise<string> {
  const [snap, heartbeat] = await Promise.all([
    runFleetSnapshotJson(),
    readLatestFirstmateHeartbeat(),
  ]);
  const active = activeTasks(snap.tasks);
  const byProject = groupByProject(active);

  const heartbeatLine = heartbeat
    ? `<p class="muted">Firstmate heartbeat: ${escapeHtml(heartbeat.ageLabel)}${heartbeat.state ? ` · ${escapeHtml(heartbeat.state)}` : ""}</p>`
    : `<p class="muted">Firstmate heartbeat: none yet. Restart the TUI after the dashboard hook is installed.</p>`;

  if (!snap.ok) {
    return `<div class="stack">
      <h3>In flight</h3>
      ${heartbeatLine}
      <p class="warn">${escapeHtml(snap.error ?? "snapshot unavailable")}</p>
    </div>`;
  }

  if (active.length === 0) {
    return `<div class="stack">
      <h3>In flight</h3>
      ${heartbeatLine}
      <p class="muted">No in-flight tasks in the snapshot.</p>
    </div>`;
  }

  const projectBlocks: string[] = [];
  for (const [project, tasks] of [...byProject.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const items = tasks
      .slice(0, 8)
      .map((t) => {
        const hold = t.captainActionable ? `<span class="detent detent-hot">captain</span>` : "";
        const age =
          t.ageSeconds != null && Number.isFinite(t.ageSeconds)
            ? `<span class="muted">${Math.round(t.ageSeconds / 60)}m</span>`
            : "";
        return `<li>
          <span>${escapeHtml(t.title || t.id)} ${hold}</span>
          <span class="row"><span class="detent">${escapeHtml(t.state)}</span>${age}</span>
        </li>`;
      })
      .join("");
    projectBlocks.push(
      `<article class="sheet">
        <h3 class="sheet-title">${escapeHtml(project)}</h3>
        <ul class="task-list">${items}</ul>
      </article>`,
    );
  }

  return `<div class="stack">
    <div class="between">
      <h3>In flight</h3>
      <span class="muted">${active.length} in flight</span>
    </div>
    ${heartbeatLine}
    <div class="grid-2">${projectBlocks.join("")}</div>
  </div>`;
}
