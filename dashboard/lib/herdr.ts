import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fleetInboxRoot, ROOT } from "./paths.ts";
import { dashLog } from "./log.ts";
import { spawnTimed } from "./proc.ts";

export const FLEET_HERDR_SESSION = "fleet";
export const ALICE_WORKSPACE_LABEL = "fleet-alice";
export const HERDR_ATTACH_HINT = "herdr session attach fleet";

export const TUI_AGENT_IDS = ["alice", "firstmate", "architect"] as const;
export type TuiAgentId = (typeof TUI_AGENT_IDS)[number];

export function isTuiAgent(agentId: string): agentId is TuiAgentId {
  return (TUI_AGENT_IDS as readonly string[]).includes(agentId);
}

export function fleetWorkspaceLabel(agentId: string): string {
  return `fleet-${agentId}`;
}

export type AgentRuntime = {
  backend: "herdr";
  herdr_session: string;
  herdr_workspace_id: string;
  herdr_pane_id: string;
};

function runtimePath(agentId: string): string {
  return join(fleetInboxRoot(), agentId, "runtime.json");
}

export async function readRuntime(agentId: string): Promise<AgentRuntime | null> {
  try {
    const raw = await readFile(runtimePath(agentId), "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as AgentRuntime;
  } catch {
    return null;
  }
}

export async function writeRuntime(
  agentId: string,
  runtime: AgentRuntime,
): Promise<void> {
  await mkdir(join(fleetInboxRoot(), agentId), { recursive: true });
  await writeFile(runtimePath(agentId), JSON.stringify(runtime, null, 2) + "\n");
}

export async function clearRuntime(agentId: string): Promise<void> {
  try {
    await writeFile(runtimePath(agentId), "");
  } catch {
    /* ignore */
  }
}

type HerdrResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

function herdrEnv(): Record<string, string | undefined> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.FM_HOME;
  delete env.FM_ROOT_OVERRIDE;
  delete env.FM_STATE_OVERRIDE;
  delete env.FM_DATA_OVERRIDE;
  return env;
}

export function safeParseHerdrJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let herdrChain: Promise<unknown> = Promise.resolve();
let herdrOnPath: boolean | null = null;

export function herdrAvailable(): boolean {
  if (herdrOnPath !== null) return herdrOnPath;
  const r = Bun.which("herdr");
  herdrOnPath = Boolean(r);
  return herdrOnPath;
}

export function herdrExec(
  args: string[],
  timeoutMs = 12_000,
): Promise<HerdrResult> {
  const run = async (): Promise<HerdrResult> => {
    const res = await spawnTimed(["herdr", ...args], {
      timeoutMs,
      env: herdrEnv(),
    });
    await dashLog(
      "herdr",
      `${args.slice(0, 4).join(" ")} ${res.ms}ms exit=${res.exitCode} timedOut=${res.timedOut}`,
    );
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
    };
  };
  const next = herdrChain.then(run, run);
  herdrChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function fleetServerRunning(): Promise<boolean> {
  const status = await herdrExec(["--session", FLEET_HERDR_SESSION, "status", "--json"]);
  const parsed = safeParseHerdrJson(status.stdout);
  return (
    parsed !== null &&
    (parsed.server as { running?: boolean } | undefined)?.running === true
  );
}

async function spawnHerdrServer(session: string): Promise<void> {
  await dashLog("herdr-server", `spawn ${session}`);
  Bun.spawn(["herdr", "--session", session, "server"], {
    stdout: "ignore",
    stderr: "ignore",
    env: herdrEnv(),
  }).unref();
}

export async function ensureHerdrServer(session: string): Promise<void> {
  if (await fleetServerRunning()) return;
  await spawnHerdrServer(session);
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(400);
    if (await fleetServerRunning()) return;
  }
  throw new Error(
    `Herdr session '${session}' is not running. Try: ${HERDR_ATTACH_HINT}`,
  );
}

export async function findWorkspaceByLabel(
  session: string,
  label: string,
): Promise<string | null> {
  const res = await herdrExec(["--session", session, "workspace", "list"]);
  const j = safeParseHerdrJson(res.stdout);
  if (!j) return null;
  const workspaces = (j.result as { workspaces?: { workspace_id: string; label: string }[] })
    ?.workspaces;
  const hit = workspaces?.find((w) => w.label === label);
  return hit?.workspace_id ?? null;
}

const workspaceCache = new Map<string, { at: number; exists: boolean }>();

export function invalidateWorkspaceCache(agentId?: string): void {
  if (agentId) {
    workspaceCache.delete(agentId);
    return;
  }
  workspaceCache.clear();
}

type PaneProcess = {
  pid?: number;
  argv?: string[];
  argv0?: string;
  cmdline?: string;
  name?: string;
  cwd?: string;
};

function processText(p: PaneProcess): string {
  return [
    p.name ?? "",
    p.argv0 ?? "",
    ...(p.argv ?? []),
    p.cmdline ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function paneProcessLooksLikeAgent(
  agentId: string,
  processes: PaneProcess[],
  sessionPid?: number,
): boolean {
  if (sessionPid && sessionPid > 0) {
    if (processes.some((p) => p.pid === sessionPid)) return true;
  }
  for (const p of processes) {
    const text = processText(p);
    if (p.name === "pi" || /\bpi\b/.test(text)) {
      if (!text.includes("pip") && !text.includes("pixel")) return true;
    }
    if (text.includes("launch") && text.includes(agentId)) return true;
    if (text.includes("bin/launch") && text.includes(agentId)) return true;
  }
  return false;
}

/** @deprecated use paneProcessLooksLikeAgent */
export function paneProcessLooksLikeAlice(processes: PaneProcess[]): boolean {
  return paneProcessLooksLikeAgent("alice", processes);
}

export async function paneProcessInfo(
  session: string,
  paneId: string,
): Promise<PaneProcess[]> {
  const res = await herdrExec([
    "--session",
    session,
    "pane",
    "process-info",
    "--pane",
    paneId,
  ]);
  const j = safeParseHerdrJson(res.stdout);
  const info = (j?.result as { process_info?: { foreground_processes?: PaneProcess[] } })
    ?.process_info;
  return info?.foreground_processes ?? [];
}

export type AgentPaneStatus = {
  live: boolean;
  workspaceId?: string;
  paneId?: string;
  reason?: string;
};

/** Read-only: never starts Herdr server or creates workspace. */
export async function agentPaneIsLive(
  agentId: string,
  sessionPid?: number,
): Promise<AgentPaneStatus> {
  const label = fleetWorkspaceLabel(agentId);
  if (!(await fleetServerRunning())) {
    return { live: false, reason: "Herdr session fleet is not running" };
  }
  const workspaceId = await findWorkspaceByLabel(FLEET_HERDR_SESSION, label);
  if (!workspaceId) {
    return { live: false, reason: `workspace ${label} missing` };
  }
  const paneId = await primaryPaneInWorkspace(FLEET_HERDR_SESSION, workspaceId);
  if (!paneId) {
    return { live: false, workspaceId, reason: `no pane in ${label}` };
  }
  const processes = await paneProcessInfo(FLEET_HERDR_SESSION, paneId);
  if (!paneProcessLooksLikeAgent(agentId, processes, sessionPid)) {
    return {
      live: false,
      workspaceId,
      paneId,
      reason: `pane is not running Pi or bin/launch ${agentId}`,
    };
  }
  return { live: true, workspaceId, paneId };
}

export async function alicePaneIsLive(): Promise<AgentPaneStatus> {
  return agentPaneIsLive("alice");
}

export async function agentWorkspaceExists(agentId: string): Promise<boolean> {
  const cached = workspaceCache.get(agentId);
  if (cached && Date.now() - cached.at < 3000) {
    return cached.exists;
  }
  if (!(await fleetServerRunning())) {
    workspaceCache.set(agentId, { at: Date.now(), exists: false });
    return false;
  }
  const id = await findWorkspaceByLabel(
    FLEET_HERDR_SESSION,
    fleetWorkspaceLabel(agentId),
  );
  workspaceCache.set(agentId, { at: Date.now(), exists: Boolean(id) });
  return Boolean(id);
}

export async function aliceWorkspaceExists(): Promise<boolean> {
  return agentWorkspaceExists("alice");
}

export async function primaryPaneInWorkspace(
  session: string,
  workspaceId: string,
): Promise<string | null> {
  const res = await herdrExec([
    "--session",
    session,
    "pane",
    "list",
    "--workspace",
    workspaceId,
  ]);
  const j = safeParseHerdrJson(res.stdout);
  const panes = (j?.result as { panes?: { pane_id: string }[] })?.panes;
  return panes?.[0]?.pane_id ?? null;
}

export async function focusWorkspace(
  session: string,
  workspaceId: string,
): Promise<void> {
  await herdrExec(["--session", session, "workspace", "focus", workspaceId]);
}

export async function ensureAgentWorkspace(agentId: string): Promise<{
  workspaceId: string;
  paneId: string;
}> {
  const session = FLEET_HERDR_SESSION;
  const label = fleetWorkspaceLabel(agentId);
  await ensureHerdrServer(session);

  let workspaceId = await findWorkspaceByLabel(session, label);
  let paneId: string | null = null;

  if (workspaceId) {
    paneId = await primaryPaneInWorkspace(session, workspaceId);
  }

  if (!workspaceId || !paneId) {
    const create = await herdrExec([
      "--session",
      session,
      "workspace",
      "create",
      "--cwd",
      ROOT,
      "--label",
      label,
      "--no-focus",
    ]);
    const cj = safeParseHerdrJson(create.stdout);
    if (create.exitCode !== 0 || !cj) {
      throw new Error(
        create.stderr ||
          create.stdout ||
          "workspace create failed (is Herdr session fleet running?)",
      );
    }
    const result = cj.result as {
      root_pane?: { pane_id: string };
      workspace?: { workspace_id: string };
    };
    workspaceId = result.workspace?.workspace_id ?? workspaceId;
    paneId = result.root_pane?.pane_id ?? paneId;
  }

  if (!workspaceId || !paneId) {
    throw new Error(`could not resolve herdr workspace/pane for ${agentId}`);
  }

  await focusWorkspace(session, workspaceId);
  return { workspaceId, paneId };
}

export async function ensureAliceWorkspace(): Promise<{
  workspaceId: string;
  paneId: string;
}> {
  return ensureAgentWorkspace("alice");
}

export async function paneRunShell(paneId: string, shellCommand: string): Promise<void> {
  const wrapped = `bash -lc ${JSON.stringify(shellCommand)}`;
  const res = await herdrExec([
    "--session",
    FLEET_HERDR_SESSION,
    "pane",
    "run",
    paneId,
    wrapped,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr || res.stdout || "pane run failed");
  }
}
