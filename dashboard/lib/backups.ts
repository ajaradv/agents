import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notifyCaptain } from "./notify.ts";
import { nodeStateDir, ROOT } from "./paths.ts";
import { spawnTimed } from "./proc.ts";
import { secretsDir } from "./secret-store.ts";

/**
 * The node job `backups` (routines.yaml, every 15m): keeps the hub's Litestream
 * replication honest. On the Linux hub only; there it re-reads the databases on
 * disk (`bin/fleet-backup reconcile`: a new ship's ship.db joins the config and
 * the service restarts) and checks the fleet-litestream service is running.
 * A ship.db the fleet itself creates is reconciled within a few seconds
 * (lib/ship-log.ts); this job is the backstop.
 *
 * Before the captain has supplied the R2 keys (docs/backups.md) the job says so
 * and reminds at most once a week. A service that is down is reported at most
 * once a day, so a long outage is a notice, not a flood.
 */

type Run = (cmd: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;
type State = { notSetUpNotice?: string; downNotice?: string };
export type BackupsDeps = {
  platform?: string;
  run?: Run;
  now?: () => Date;
  envFileExists?: () => boolean;
  notify?: typeof notifyCaptain;
  stateFile?: string;
};

const DAY_MS = 86_400_000;
const NOT_SET_UP = "not set up (see bin/fleet-backup)";

const defaultRun: Run = async (cmd, timeoutMs = 120_000) => {
  const r = await spawnTimed(cmd, { timeoutMs });
  return { code: r.timedOut ? 124 : r.exitCode, out: `${r.stdout}\n${r.stderr}`.trim() };
};

export const litestreamEnvFile = () => join(secretsDir(), "litestream.env");

export function backupsJob(deps: BackupsDeps = {}): () => Promise<string> {
  return async () => {
    if ((deps.platform ?? process.platform) !== "linux") return "skipped: not the hub";
    const now = (deps.now ?? (() => new Date()))();
    const notify = deps.notify ?? notifyCaptain;
    const file = deps.stateFile ?? join(nodeStateDir(), "backups.json");
    let state: State = {};
    try {
      state = JSON.parse(readFileSync(file, "utf8")) as State;
    } catch {
      /* first run */
    }
    const due = (last: string | undefined, ms: number) => !last || now.getTime() - new Date(last).getTime() >= ms;
    const save = (patch: State) => writeFileSync(file, JSON.stringify({ ...state, ...patch }));
    const run = deps.run ?? defaultRun;

    if (!(deps.envFileExists ?? (() => existsSync(litestreamEnvFile())))()) {
      if (due(state.notSetUpNotice, 7 * DAY_MS)) {
        notify({ from: "backups", kind: "info", summary: "Hub backups are not set up", detail: "The hub's databases are not replicated anywhere yet. Create the R2 bucket and token, then follow docs/backups.md (bin/fleet-backup prints exactly what is needed).", ref: "docs/backups.md" });
        save({ notSetUpNotice: now.toISOString() });
      }
      return NOT_SET_UP;
    }

    const rec = await run([join(ROOT, "bin", "fleet-backup"), "reconcile"]);
    if (rec.code === 3) return NOT_SET_UP;
    const problems: string[] = [];
    if (rec.code !== 0) problems.push(`reconcile failed (exit ${rec.code}): ${rec.out.split("\n").slice(-3).join(" ")}`);
    const active = await run(["systemctl", "is-active", "fleet-litestream"]);
    if (active.code !== 0) problems.push(`fleet-litestream is ${active.out.split("\n")[0] || "not active"}`);

    if (problems.length) {
      if (due(state.downNotice, DAY_MS)) {
        notify({ from: "backups", kind: active.code !== 0 ? "blocked" : "info", summary: "Hub backups need attention", detail: `${problems.join("\n")}\n\nTry bin/fleet-backup install on the hub, then bin/fleet-backup status.`, ref: "docs/backups.md" });
        save({ downNotice: now.toISOString() });
      }
      return problems.join("; ");
    }
    const changed = rec.out.split("\n").filter((l) => /^wrote |^\s+(added|removed) /.test(l));
    return changed.length ? `config updated: ${changed.map((l) => l.trim()).join(", ")}` : "replicating; config current";
  };
}

/**
 * The node job `backup-drill` (routines.yaml, weekly): the real check that the
 * backups restore. `bin/fleet-backup drill` restores every replicated database
 * into a temp dir, runs integrity_check and compares row counts with the live
 * ones. The `backups` job only sees that the service is active, which missed a
 * wrong Litestream binary for 4.5 days (2026-10-31). A failed drill is a
 * blocked notice (a phone push); one notice per run.
 */
const DRILL_TIMEOUT_MS = 10 * 60_000;
const LAG_ROWS = 500;

export function backupDrillJob(deps: BackupsDeps = {}): () => Promise<string> {
  return async () => {
    if ((deps.platform ?? process.platform) !== "linux") return "skipped: not the hub";
    // The `backups` job already nags about a missing env file.
    if (!(deps.envFileExists ?? (() => existsSync(litestreamEnvFile())))()) return NOT_SET_UP;
    const notify = deps.notify ?? notifyCaptain;
    const r = await (deps.run ?? defaultRun)([join(ROOT, "bin", "fleet-backup"), "drill"], DRILL_TIMEOUT_MS);
    const lines = r.out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (r.code !== 0) {
      const fails = lines.filter((l) => l.startsWith("FAIL"));
      const shown = fails.length ? fails : lines.slice(-10);
      const why = r.code === 124 ? `The drill timed out after ${DRILL_TIMEOUT_MS / 60_000} minutes.\n` : "";
      notify({ from: "backups", kind: "blocked", summary: "Hub backup drill failed", detail: `${why}${shown.join("\n")}\n\nRun bin/hub fleet-backup drill, then bin/fleet-backup status; docs/backups.md.`, ref: "docs/backups.md" });
      return `drill failed (exit ${r.code}): ${shown.slice(0, 3).join("; ")}`;
    }
    const dbs = lines.filter((l) => l.startsWith("ok ")).length;
    const total = lines.map((l) => /^total: (\d+)s/.exec(l)?.[1]).find(Boolean);
    let out = `drill passed: ${dbs} database${dbs === 1 ? "" : "s"}${total ? ` in ${total}s` : ""}`;
    const lag = Math.max(0, ...lines.map((l) => Number(/live ahead by (\d+)/.exec(l)?.[1] ?? 0)));
    if (lag >= LAG_ROWS) out += `; warning: live is ${lag} rows ahead of the restore (replication may be lagging)`;
    return out;
  };
}
