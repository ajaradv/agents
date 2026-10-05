import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./paths.ts";
import { readRuntime, agentPaneIsLive, FLEET_HERDR_SESSION } from "./herdr.ts";
import { readSession, pidAlive } from "./session.ts";
import { spawnTimed } from "./proc.ts";

export const FM_HOME = join(ROOT, "fleet", "home");

export async function firstmateTuiReachable(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const session = await readSession("firstmate");
  const pane = await agentPaneIsLive("firstmate", session?.pid);
  if (pane.live) return { ok: true };
  if (session?.pid && pidAlive(session.pid)) {
    return {
      ok: true,
      reason: "Firstmate running outside fleet-firstmate pane — attach your existing terminal",
    };
  }
  return {
    ok: false,
    reason: "Start Firstmate TUI (Start TUI) or run just firstmate before sending chat",
  };
}

/** Herdr backend target for fm-send, e.g. fleet:w3:p1 */
export async function resolveFirstmateSendTarget(): Promise<string | null> {
  const session = await readSession("firstmate");
  if (session?.herdr_session && session?.herdr_pane_id) {
    return `${session.herdr_session}:${session.herdr_pane_id}`;
  }
  const runtime = await readRuntime("firstmate");
  if (runtime?.herdr_session && runtime?.herdr_pane_id) {
    return `${runtime.herdr_session}:${runtime.herdr_pane_id}`;
  }
  const pane = await agentPaneIsLive("firstmate", session?.pid);
  if (pane.live && pane.paneId) {
    return `${FLEET_HERDR_SESSION}:${pane.paneId}`;
  }
  const stateDir = join(FM_HOME, "state");
  try {
    const files = await readdir(stateDir);
    for (const f of files) {
      if (!f.endsWith(".meta")) continue;
      const id = f.replace(/\.meta$/, "");
      if (id.startsWith("fm-")) {
        return id;
      }
      const meta = await readFile(join(stateDir, f), "utf8");
      if (/backend=herdr/i.test(meta) || /herdr/i.test(meta)) {
        return id.startsWith("fm-") ? id : `fm-${id}`;
      }
    }
    const first = files.find((f) => f.endsWith(".meta"));
    if (first) {
      const id = first.replace(/\.meta$/, "");
      return id.startsWith("fm-") ? id : `fm-${id}`;
    }
  } catch {
    /* no state */
  }
  return null;
}

export async function sendToFirstmateTui(text: string): Promise<{
  ok: boolean;
  ms: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}> {
  const reachable = await firstmateTuiReachable();
  if (!reachable.ok) {
    return {
      ok: false,
      ms: 0,
      exitCode: 1,
      stderr: reachable.reason ?? "Firstmate TUI not running",
      stdout: "",
      timedOut: false,
    };
  }
  const target = await resolveFirstmateSendTarget();
  if (!target) {
    return {
      ok: false,
      ms: 0,
      exitCode: 1,
      stderr:
        "Could not resolve fm-send target (need Herdr pane or fleet/home/state/*.meta). Attach the TUI and try again.",
      stdout: "",
      timedOut: false,
    };
  }
  const fmSend = join(FM_HOME, "bin", "fm-send.sh");
  const env = {
    ...process.env,
    FM_HOME,
  };
  const res = await spawnTimed(["bash", fmSend, target, text], {
    timeoutMs: 60_000,
    cwd: FM_HOME,
    env,
  });
  return {
    ok: res.exitCode === 0 && !res.timedOut,
    ms: res.ms,
    exitCode: res.exitCode,
    stderr: res.stderr,
    stdout: res.stdout,
    timedOut: res.timedOut,
  };
}

function shortFmSendError(stderr: string, stdout: string): string {
  const raw = (stderr || stdout || "fm-send failed").trim();
  const lines = raw.split("\n").filter(Boolean);
  const first = lines.find((l) => l.toLowerCase().includes("error")) ?? lines[0] ?? raw;
  if (first.length > 280) return first.slice(0, 280) + "…";
  return first;
}

export function formatFirstmateSendError(stderr: string, stdout: string): string {
  return shortFmSendError(stderr, stdout);
}
