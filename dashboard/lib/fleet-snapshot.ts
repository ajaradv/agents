import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { syncCaptainWait, type WaitHold } from "./captain-wait.ts";
import { firstmateTuiReachable, FM_HOME } from "./firstmate-chat.ts";
import {
  initiativesSectionHtml,
  readInitiatives,
  readShips,
  shipsSectionHtml,
} from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";

/** Same pattern as chat-targets; kept here to avoid an import cycle. */
const CHAT_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
import { escapeHtml } from "./quota.ts";

export type FirstmateHeartbeat = {
  ts: string;
  state?: string;
  ageLabel: string;
};

type SnapshotState = {
  state?: string;
  age_seconds?: number | null;
  detail?: string;
};

type BacklogRecord = {
  id?: string | null;
  title?: string;
  state?: string;
  repo?: string;
  kind?: string;
  hold_reason?: string | null;
  captain_actionable?: boolean;
  hold_bucket?: string;
  hold_age_days?: number;
};

type SnapshotTask = {
  id?: string;
  title?: string;
  project?: string;
  kind?: string;
  captain_actionable?: boolean;
  hold_reason?: string | null;
  hold_bucket?: string;
  hold_age_days?: number;
  current_state?: SnapshotState;
  backlog?: BacklogRecord | null;
};

type HomeChild = {
  id?: string;
  kind?: string;
  state?: string;
  repo?: string;
  name?: string;
  doing?: string;
};

type HomeQueued = {
  id?: string;
  title?: string;
  repo?: string;
  kind?: string;
  hold_reason?: string | null;
  captain_actionable?: boolean;
};

type HomeHold = {
  id?: string;
  title?: string;
  reason?: string;
};

type HomeSummary = {
  state?: string;
  valid?: boolean;
  reason?: string | null;
  generated?: string;
  active_children?: HomeChild[];
  queued?: HomeQueued[];
  holds?: HomeHold[];
  decisions_open?: Array<{ id?: string; reason?: string; summary?: string }>;
};

type ProjectRow = {
  id: string;
  note: string;
};

type WorkRow = {
  id: string;
  title: string;
  state: string;
  project: string;
  doing?: string;
  holdReason: string;
  captainActionable: boolean;
};

export type FleetSnapshot = {
  ok: boolean;
  error?: string;
  tasks: SnapshotTask[];
  backlog: BacklogRecord[];
};

const TERMINAL = new Set(["done", "failed"]);
const SNAPSHOT_TIMEOUT_MS = 15_000;

export async function runFleetSnapshotJson(): Promise<FleetSnapshot> {
  const snapshotPath = join(FM_HOME, "bin", "fm-fleet-snapshot.sh");
  try {
    const res = Bun.spawn(["bash", snapshotPath, "--json"], {
      cwd: FM_HOME,
      env: { ...process.env, FM_HOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    // A hung script must not hold the rail: kill it after SNAPSHOT_TIMEOUT_MS.
    // stderr is drained too, or a chatty script blocks on a full pipe.
    const timer = setTimeout(() => res.kill(), SNAPSHOT_TIMEOUT_MS);
    const [stdout, , exitCode] = await Promise.all([
      new Response(res.stdout).text(),
      new Response(res.stderr).text(),
      res.exited,
    ]).finally(() => clearTimeout(timer));
    if (exitCode !== 0) {
      return { ok: false, error: "snapshot unavailable", tasks: [], backlog: [] };
    }
    const j = JSON.parse(stdout) as {
      tasks?: SnapshotTask[];
      backlog?: { records?: BacklogRecord[] };
    };
    return {
      ok: true,
      tasks: j.tasks ?? [],
      backlog: j.backlog?.records ?? [],
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "snapshot failed",
      tasks: [],
      backlog: [],
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
    if (last) last.ageLabel = formatAge(Date.parse(last.ts));
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

export function projectSlug(value: string | undefined | null): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parts = raw.replace(/\/+$/, "").split(/[/\\]/);
  return (parts[parts.length - 1] ?? raw).toLowerCase();
}

export function parseProjectsMarkdown(text: string): ProjectRow[] {
  const rows: ProjectRow[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^[-*]\s+(\S+)/);
    if (!m?.[1]) continue;
    const id = projectSlug(m[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const note = line.replace(/^[-*]\s+\S+\s*/, "").replace(/^-\s*/, "").trim();
    rows.push({ id, note });
  }
  return rows;
}

export function collectCaptainHolds(snap: FleetSnapshot): WaitHold[] {
  const byId = new Map<string, WaitHold>();
  const add = (id: string, title: string, holdReason: string) => {
    if (!id || byId.has(id)) return;
    byId.set(id, { id, title: title || id, holdReason });
  };
  for (const rec of snap.backlog) {
    if (!rec.captain_actionable || !rec.id) continue;
    add(rec.id, rec.title ?? rec.id, String(rec.hold_reason ?? ""));
  }
  for (const t of snap.tasks) {
    const rec = t.backlog;
    const actionable = Boolean(t.captain_actionable || rec?.captain_actionable);
    if (!actionable || !t.id) continue;
    add(
      t.id,
      rec?.title ?? t.title ?? t.id,
      String(t.hold_reason ?? rec?.hold_reason ?? ""),
    );
  }
  return [...byId.values()];
}

async function readHomeSummary(): Promise<HomeSummary | null> {
  try {
    return JSON.parse(
      await readFile(join(FM_HOME, "state", "home-summary.json"), "utf8"),
    ) as HomeSummary;
  } catch {
    return null;
  }
}

async function readRegisteredProjects(): Promise<ProjectRow[]> {
  try {
    return parseProjectsMarkdown(
      await readFile(join(FM_HOME, "data", "projects.md"), "utf8"),
    );
  } catch {
    return [];
  }
}

function holdForm(h: WaitHold): string {
  const reason = h.holdReason || h.title;
  return `<form class="hold-form" hx-post="/api/holds/${escapeHtml(h.id)}/answer" hx-swap="outerHTML">
    <p class="warn">${escapeHtml(reason)}</p>
    <label>Answer before this ships
      <textarea class="field" name="text" required maxlength="8000" aria-label="Answer for ${escapeHtml(h.title || h.id)}"></textarea>
    </label>
    <button class="btn btn-ink" type="submit">Record answer</button>
  </form>`;
}

function workList(title: string, rows: WorkRow[], empty: string, chat = false): string {
  if (rows.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  const items = rows
    .slice(0, 8)
    .map((t) => {
      const hold = t.captainActionable
        ? `<span class="detent detent-hot">captain</span>`
        : "";
      const doing = t.doing
        ? `<p class="muted">${escapeHtml(t.doing)}</p>`
        : "";
      const reason =
        t.captainActionable && t.holdReason
          ? `<p class="warn">${escapeHtml(t.holdReason)}</p>`
          : "";
      return `<li class="${t.captainActionable ? "task-hold" : ""}">
        <div class="between">
          <span>${escapeHtml(t.title || t.id)} ${hold}</span>
          <span class="row">
            <span class="detent">${escapeHtml(t.state)}</span>
            ${chat && CHAT_ID_RE.test(t.id) ? `<button type="button" class="btn" @click="openChat('${escapeHtml(t.id)}')" aria-label="Chat with ${escapeHtml(t.title || t.id)}">Chat</button>` : ""}
          </span>
        </div>
        ${doing}${reason}
      </li>`;
    })
    .join("");
  return `<h4>${escapeHtml(title)}</h4><ul class="task-list">${items}</ul>`;
}

function firstmateCard(opts: {
  home: HomeSummary | null;
  heartbeat: FirstmateHeartbeat | null;
  tui: { ok: boolean; reason?: string };
  holds: WaitHold[];
}): string {
  const state = opts.home?.state ?? "unknown";
  const valid = opts.home?.valid;
  const heartbeat = opts.heartbeat
    ? `Heartbeat ${opts.heartbeat.ageLabel}${opts.heartbeat.state ? ` · ${opts.heartbeat.state}` : ""}`
    : "Heartbeat none yet";
  const tui = opts.tui.ok
    ? "TUI attached"
    : `TUI not attached${opts.tui.reason ? ` — ${opts.tui.reason}` : ""}`;
  const validity =
    valid === false
      ? `<p class="warn">Summary invalid${opts.home?.reason ? `: ${escapeHtml(opts.home.reason)}` : ""}</p>`
      : `<p class="muted">Summary ${valid === true ? "valid" : "not written yet"}</p>`;
  const holdBlock =
    opts.holds.length > 0
      ? `<div class="stack">${opts.holds.map(holdForm).join("")}</div>`
      : "";
  return `<article class="sheet stack">
    <div class="between">
      <h3 class="sheet-title">Firstmate</h3>
      <span class="${state === "captain_decision" ? "detent detent-hot" : "detent"}">${escapeHtml(state)}</span>
    </div>
    <p class="muted">${escapeHtml(heartbeat)}</p>
    <p class="${opts.tui.ok ? "muted" : "warn"}">${escapeHtml(tui)}</p>
    ${validity}
    ${holdBlock}
  </article>`;
}

function projectCard(
  project: ProjectRow,
  active: WorkRow[],
  queued: WorkRow[],
  waiting: WaitHold[],
): string {
  const idle = active.length === 0 && queued.length === 0 && waiting.length === 0;
  return `<article class="sheet stack">
    <div class="between">
      <h3 class="sheet-title">${escapeHtml(project.id)}</h3>
      <span class="detent">${idle ? "idle" : `${active.length} active`}</span>
    </div>
    ${project.note ? `<p class="muted">${escapeHtml(project.note)}</p>` : ""}
    ${workList("Active", active, "Nothing in flight.", true)}
    ${workList("Queued", queued, "Nothing queued.")}
    ${
      waiting.length > 0
        ? `<h4>Waiting on you</h4>${waiting.map(holdForm).join("")}`
        : ""
    }
  </article>`;
}

function taskTitle(t: SnapshotTask): string {
  return t.backlog?.title ?? t.title ?? t.id ?? "task";
}

function taskProject(t: SnapshotTask): string {
  return projectSlug(t.backlog?.repo) || projectSlug(t.project);
}

export async function fleetStripHtml(): Promise<string> {
  const [snap, heartbeat, home, projects, tui, ships, initiatives] = await Promise.all([
    runFleetSnapshotJson(),
    readLatestFirstmateHeartbeat(),
    readHomeSummary(),
    readRegisteredProjects(),
    firstmateTuiReachable(),
    readShips(),
    readInitiatives(),
  ]);
  const projectIds = new Set(projects.map((p) => p.id));

  const holds = snap.ok ? collectCaptainHolds(snap) : [];
  if (snap.ok) await syncCaptainWait(holds);

  if (!snap.ok) {
    return `<div class="stack">
      ${firstmateCard({ home, heartbeat, tui, holds })}
      <p class="warn">${escapeHtml(snap.error ?? "snapshot unavailable")}</p>
      ${shipsSectionHtml(ships, projectIds)}
      ${initiativesSectionHtml(initiatives, () => 0)}
    </div>`;
  }

  const activeByProject = new Map<string, WorkRow[]>();
  const queuedByProject = new Map<string, WorkRow[]>();
  const waitingByProject = new Map<string, WaitHold[]>();
  const push = (map: Map<string, WorkRow[]>, slug: string, row: WorkRow) => {
    const list = map.get(slug) ?? [];
    if (list.some((r) => r.id === row.id)) return;
    list.push(row);
    map.set(slug, list);
  };

  for (const child of home?.active_children ?? []) {
    if (!child.id) continue;
    push(activeByProject, projectSlug(child.repo) || "(unregistered)", {
      id: child.id,
      title: child.name ?? child.id,
      state: child.state ?? "working",
      project: projectSlug(child.repo),
      doing: child.doing,
      holdReason: "",
      captainActionable: false,
    });
  }

  for (const t of snap.tasks) {
    const state = t.current_state?.state ?? "unknown";
    if (TERMINAL.has(state) || !t.id) continue;
    const slug = taskProject(t) || "(unregistered)";
    const rec = t.backlog;
    push(activeByProject, slug, {
      id: t.id,
      title: taskTitle(t),
      state,
      project: slug,
      doing: t.current_state?.detail,
      holdReason: String(t.hold_reason ?? rec?.hold_reason ?? ""),
      captainActionable: Boolean(t.captain_actionable || rec?.captain_actionable),
    });
  }

  for (const rec of snap.backlog) {
    if (!rec.id || rec.state !== "queued") continue;
    const slug = projectSlug(rec.repo) || "(unregistered)";
    push(queuedByProject, slug, {
      id: rec.id,
      title: rec.title ?? rec.id,
      state: "queued",
      project: slug,
      holdReason: String(rec.hold_reason ?? ""),
      captainActionable: Boolean(rec.captain_actionable),
    });
  }

  for (const rec of home?.queued ?? []) {
    if (!rec.id) continue;
    const slug = projectSlug(rec.repo) || "(unregistered)";
    push(queuedByProject, slug, {
      id: rec.id,
      title: rec.title ?? rec.id,
      state: "queued",
      project: slug,
      holdReason: String(rec.hold_reason ?? ""),
      captainActionable: Boolean(rec.captain_actionable),
    });
  }

  for (const h of holds) {
    const rec = snap.backlog.find((r) => r.id === h.id);
    const task = snap.tasks.find((t) => t.id === h.id);
    const slug =
      projectSlug(rec?.repo) ||
      taskProject(task ?? {}) ||
      "(unregistered)";
    const list = waitingByProject.get(slug) ?? [];
    if (!list.some((x) => x.id === h.id)) list.push(h);
    waitingByProject.set(slug, list);
  }

  const seen = new Set(projects.map((p) => p.id));
  const extra = [...activeByProject.keys(), ...queuedByProject.keys(), ...waitingByProject.keys()]
    .filter((id) => id && !seen.has(id))
    .sort();
  const cards = [
    ...projects,
    ...extra.map((id) => ({ id, note: "" })),
  ].map((project) =>
    projectCard(
      project,
      activeByProject.get(project.id) ?? [],
      queuedByProject.get(project.id) ?? [],
      waitingByProject.get(project.id) ?? [],
    ),
  );

  return `<div class="stack">
    ${firstmateCard({ home, heartbeat, tui, holds })}
    <div class="between">
      <h3>Projects</h3>
      <span class="muted">${projects.length} registered</span>
    </div>
    <div class="grid-2">${cards.join("")}</div>
    ${shipsSectionHtml(ships, projectIds)}
    ${initiativesSectionHtml(initiatives, (id) => activeByProject.get(id)?.length ?? 0)}
  </div>`;
}
