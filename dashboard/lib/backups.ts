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

type Run = (cmd: string[]) => Promise<{ code: number; out: string }>;
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

const defaultRun: Run = async (cmd) => {
  const r = await spawnTimed(cmd, { timeoutMs: 120_000 });
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
