import { existsSync } from "node:fs";
import { jevAsk } from "./jev.ts";
import { redact } from "./redact.ts";
import { readShips } from "./fleet-layers.ts";
import { checkVerdict } from "./proc.ts";
import { localHost, type ShipHost } from "./ship-host.ts";
import { recordRun } from "./metrics.ts";
import { ROOT } from "./paths.ts";
import { rigEnv } from "./rig.ts";
import { logShipEvent } from "./ship-log.ts";
import { ulid } from "./ulid.ts";
import { voyageHost, voyageWorktree } from "./voyage-worktree.ts";

/**
 * Host checks (R4): a crewmate whose tools run in a VM cannot run Docker, and
 * some ships test only through Docker Compose (pochteca: `just pytest`). So
 * the captain lists commands per ship (`checks:` in fleet/ships/<ship>.yaml),
 * and a crewmate may run one of them by name on the host, in the ship's repo,
 * with a time limit. It picks the name; it never writes the command line.
 */

const TIMEOUT_MS = Math.max(30, Number(process.env.FLEET_CHECK_TIMEOUT_SECS) || 900) * 1000;
/** Rigging builds images and migrates a fresh database: longer than a check. */
const RIG_TIMEOUT_MS = Math.max(TIMEOUT_MS, 1_800_000);
const OUTPUT_MAX = 12_000;
const running = new Set<string>();

/** The end of long output (test failures are at the bottom). */
export function tail(text: string, max = OUTPUT_MAX): string {
  return text.length <= max ? text : `[… ${text.length - max} earlier characters cut …]\n${text.slice(-max)}`;
}

/** The commit a folder is on and whether it has uncommitted changes (ignored files do not count). */
export async function treeState(cwd: string, host: ShipHost = localHost): Promise<{ commit: string; dirty: boolean }> {
  const head = await host.exec(["git", "rev-parse", "HEAD"], { timeoutMs: 15_000, cwd });
  const status = await host.exec(["git", "status", "--porcelain"], { timeoutMs: 30_000, cwd });
  return { commit: head.exitCode === 0 ? head.stdout.trim() : "", dirty: status.exitCode !== 0 || status.stdout.trim().length > 0 };
}

/** What a failed check's cause usually means for the next step (failure triage, vault note jev-system-one). */
const TRIAGE_HINT: Record<string, string> = {
  code_bug: "fix the code the failure points at, then run the check again",
  test_problem: "look at the test itself (outdated expectation, timing, ordering, random data) before changing the code",
  environment: "the tooling failed, not the code (Docker, a missing binary or dependency, network, permissions, disk, a port): fix or report the environment rather than editing code",
  other: "read the output closely",
};

/**
 * Failure triage (Level 10A): one Jev choice over the redacted end of a failed
 * check's output. Advisory: it adds a line to the result, it never changes it.
 */
export async function triageFailure(name: string, cmd: string, output: string, ask: typeof jevAsk = jevAsk): Promise<string | null> {
  const r = await ask("failure-triage", { check: name, command: cmd, output_tail: redact(output).slice(-6000) }, {
    cause: {
      type: "choice",
      instructions: "A project check (tests, lint, or build) failed. From `output_tail`, what most likely caused the failure?",
      criteria: {
        code_bug: "A real failure in the code under test: an assertion that does not hold, an exception or type error raised by the project's own code, a lint rule the code breaks",
        test_problem: "The test itself is wrong or unreliable: an outdated expected value, a timing or ordering dependence, random data, a flaky external call",
        environment: "The tooling or environment failed rather than the code: Docker or a service not running, a missing binary or dependency, a network or registry error, permissions, disk space, a port in use",
        other: "None of these, or the output does not say",
      },
    },
  });
  if (!r.ok) return null;
  const a = r.answers.cause;
  if (!a || a.type !== "choice" || a.choice === "other" || a.confidence < 0.5) return null;
  const pct = Math.round((a.probabilities[a.choice] ?? a.confidence) * 100);
  return `Triage (Jev, advisory): most likely ${a.choice.replace("_", " ")} (${pct}%); ${TRIAGE_HINT[a.choice]}.`;
}

/** zsh on macOS (the laptop and its login PATH); the hub and exe.dev VMs are Linux without zsh, so bash there. */
export function checkShell(host: ShipHost, has = existsSync): string {
  if (host.kind === "vm") return "/bin/bash";
  if (host.kind !== "local") return "/bin/zsh";
  return has("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
}

export async function runCheck(shipId: string, from: string, name: string, deps: { host?: ShipHost } = {}): Promise<{ ok: boolean; message: string }> {
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship) return { ok: false, message: `No ship ${shipId}.` };
  const names = Object.keys(ship.checks);
  const cmd = ship.checks[name];
  if (!cmd) return { ok: false, message: names.length ? `No check named "${name}" on ${shipId}. Checks: ${names.join(", ")}.` : `${shipId} lists no checks (the captain adds them under checks: in its ship file).` };
  const key = `${shipId}\u0000${name}`;
  if (running.has(key)) return { ok: false, message: `Check ${name} is already running on ${shipId}; wait for it.` };
  running.add(key);
  const started = Date.now();
  logShipEvent(shipId, from, "check", `Check ${name} started: ${cmd}`, { name, cmd });
  try {
    // In the voyage's worktree when one is open (the crew's work), else the repo.
    // A login shell, so the captain's PATH (just, docker, uv) resolves as in a terminal.
    // On the voyage's ship host (lib/ship-host.ts), where the worktree is.
    const cwd = voyageWorktree(shipId)?.path ?? ship.path;
    const host = deps.host ?? voyageHost(shipId);
    // What code this run checks: gates count only runs on the current commit with a clean tree.
    const { commit, dirty } = await treeState(cwd, host);
    // FLEET_SHIP_REPO: the captain's checkout on that host, for gitignored setup a fresh worktree lacks (.envs).
    const repo = await host.repoPath(ship).catch(() => ship.path);
    // The voyage's rig (lib/rig.ts): its Compose project and port, so checks hit the voyage's own stack.
    const rig = rigEnv(ship.rig, voyageWorktree(shipId)?.rig, shipId);
    // On a worker the run has a key the worker queues its own record under (lib/outbox.ts): if the answer is lost, its copy
    // reaches the hub's ingest later; whichever record lands second is a duplicate.
    const eventKey = host.kind === "local" ? undefined : ulid();
    const run = eventKey ? { event_key: eventKey, ship: shipId, agent: from, name, kind: "check" as const, commit, dirty } : undefined;
    const res = await host.exec([checkShell(host), "-lc", cmd], { timeoutMs: name === "rig" ? RIG_TIMEOUT_MS : TIMEOUT_MS, cwd, env: { ...process.env, CI: "1", FLEET_SHIP_REPO: repo, FLEET_AGENTS: ROOT, ...rig }, ...(run ? { run } : {}) });
    const secs = Math.round((Date.now() - started) / 1000);
    const passed = !res.timedOut && res.exitCode === 0;
    const verdict = checkVerdict(res, secs);
    logShipEvent(shipId, from, "check", `Check ${name} ${verdict}`, { name, exitCode: res.exitCode, timedOut: res.timedOut, secs });
    // No answer from a worker says nothing about the check (it may be running or done there): its own record is the truth, so none from here.
    if (!res.unreachable) recordRun({ eventKey, ship: shipId, agent: from, kind: "check", name, ok: passed, ms: Date.now() - started, detail: verdict, commit, dirty });
    const out = tail(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`.trim());
    const triage = !passed && !res.timedOut && !res.unreachable && out ? await triageFailure(name, cmd, out).catch(() => null) : null;
    if (triage) logShipEvent(shipId, "helm", "check", `Check ${name}: ${triage}`, { name });
    return { ok: passed, message: `Check ${name} (${cmd}) ${verdict}.${triage ? `\n${triage}` : ""}\n\n${out || "(no output)"}` };
  } finally {
    running.delete(key);
  }
}
