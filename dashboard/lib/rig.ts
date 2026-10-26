import { cp, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { overlayDir } from "./ship-config.ts";

/**
 * Rigging (vault plan fleet/plans/feature/ship-rigging): every voyage gets its
 * own running copy of the ship's app, set up and proven before the crew gets
 * the goal. A ship declares it once:
 *
 *   rig:
 *     env: [kinwork/.envs]        # gitignored files, from this host's store (fleet/home/ships/<ship>/env/)
 *     vars: {COMPOSE_FILE: ...}   # extra environment for rig steps, checks, and the crew
 *     up: [step, step, ...]       # run in order in the voyage's worktree
 *     ready: http://localhost:${FLEET_RIG_PORT}/   # optional: must answer 200 with its stylesheets (bin/rig-ready)
 *     down: step                  # at dock and when the voyage moves
 *
 * The fleet turns `up` + `ready` into a check named `rig` and `down` into
 * `rig-down`, so rigging runs like any check: on the voyage's host, in its
 * worktree, logged, timed, and on the laptop only because the laptop's own
 * config lists it. Each voyage gets a Compose project and a port of its own
 * (RigRecord, kept in the voyage's worktree record), so voyage stacks run
 * beside each other and beside the captain's.
 */

export type RigDecl = { env: string[]; vars: Record<string, string>; up: string[]; ready: string; down: string };

/** A voyage's copy: its Compose project and port, its preview, and how rigging went. */
export type RigRecord = {
  project: string;
  port: number;
  slug: string;
  preview: string;
  state: "pending" | "rigging" | "ready" | "failed";
  at?: string;
  message?: string;
  /** The voyage brief waiting for a ready rig (sent once, then dropped). */
  brief?: { to: string; text: string };
};

export const PORT_POOL = { from: 4100, to: 4199 } as const;
const VAR_RE = /^[A-Z][A-Z0-9_]{0,40}$/;
/** Variables the fleet sets itself; a ship's `vars` cannot replace them. */
const FLEET_VARS = new Set(["COMPOSE_PROJECT_NAME", "FLEET_RIG_PORT", "FLEET_RIG_SLUG", "FLEET_RIG_PREVIEW", "FLEET_AGENTS", "FLEET_SHIP_REPO", "PATH", "HOME"]);
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** A relative path inside the worktree (no absolute paths, no `..`). */
export const safeRel = (p: string) => Boolean(p) && !p.startsWith("/") && !normalize(p).split("/").includes("..");

export function parseRig(raw: unknown): RigDecl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const up = strList(r.up);
  const ready = typeof r.ready === "string" ? r.ready.trim() : "";
  // `ready` is optional (a ship with no web app, such as a Rust library); when given it is a URL.
  if (!up.length || (ready && !/^https?:\/\//.test(ready))) return null;
  const vars = Object.fromEntries(
    Object.entries((r.vars as Record<string, unknown> | null) ?? {})
      .filter(([k, v]) => VAR_RE.test(k) && !FLEET_VARS.has(k) && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => [k, String(v)]),
  );
  return { env: strList(r.env).filter(safeRel), vars, up, ready, down: typeof r.down === "string" ? r.down.trim() : "" };
}

/** The checks rigging adds to a ship: `rig` (up, then the ready probe) and `rig-down`. */
export function rigChecks(rig: RigDecl | null): Record<string, string> {
  if (!rig) return {};
  return {
    // Each step in its own subshell, from the worktree's root (a `cd` in one step must not move the next).
    rig: rig.up.map((step) => `( ${step} )`).join(" && ") + (rig.ready ? ` && "$FLEET_AGENTS/bin/rig-ready" "${rig.ready}"` : ""),
    ...(rig.down ? { "rig-down": rig.down } : {}),
  };
}

/** The voyage's Compose project: the ship and the voyage's short name. */
export function rigProject(shipId: string, slug: string): string {
  const s = `${shipId}-${slug}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s.slice(0, 48).replace(/-$/, "") || shipId;
}

/** The lowest free port of the pool, given the ones other voyages on that host hold. */
export function freePort(taken: number[]): number | null {
  for (let p = PORT_POOL.from; p <= PORT_POOL.to; p++) if (!taken.includes(p)) return p;
  return null;
}

/** The ready URL with the voyage's port and short name filled in (lineage_atria's previews are <slug>.localhost). */
export const previewUrl = (ready: string, port: number, slug = "") =>
  ready.replace(/\$\{FLEET_RIG_PORT\}|\$FLEET_RIG_PORT\b/g, String(port)).replace(/\$\{FLEET_RIG_SLUG\}|\$FLEET_RIG_SLUG\b/g, slug);

/** A voyage's short name: lowercase words and hyphens, a letter first, at most 32 characters (fits Compose and ship tooling). */
export function rigSlug(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^[-0-9]+/, "").slice(0, 32).replace(/-+$/, "");
  return s || "voyage";
}

/** What a rig record may carry across to another host (the laptop checks it before use). */
export function validRig(r: unknown): Pick<RigRecord, "project" | "port" | "slug"> | null {
  if (!r || typeof r !== "object") return null;
  const { project, port, slug } = r as Record<string, unknown>;
  const p = Number(port);
  if (typeof project !== "string" || !PROJECT_RE.test(project)) return null;
  if (!Number.isInteger(p) || p < PORT_POOL.from || p > PORT_POOL.to) return null;
  return { project, port: p, slug: typeof slug === "string" && PROJECT_RE.test(slug) ? slug : project };
}

/**
 * Environment for rig steps, checks, and the crew: the ship's vars, then the
 * voyage's project and port. Outside a voyage (a check on the captain's
 * checkout) the ship's vars still apply, in a `<ship>-checks` project of its
 * own, so they never touch a stack someone started by hand.
 */
export function rigEnv(rig: RigDecl | null, rec: Pick<RigRecord, "project" | "port" | "slug"> | null | undefined, shipId?: string): Record<string, string> {
  if (!rig) return {};
  if (!rec) return { ...rig.vars, ...(shipId ? { COMPOSE_PROJECT_NAME: rigProject(shipId, "checks") } : {}) };
  return { ...rig.vars, COMPOSE_PROJECT_NAME: rec.project, FLEET_RIG_PORT: String(rec.port), FLEET_RIG_SLUG: rec.slug, FLEET_RIG_PREVIEW: previewUrl(rig.ready, rec.port, rec.slug) };
}

/** This host's store of a ship's gitignored files (machine-local, never in git). */
export const rigStore = (shipId: string) => join(overlayDir(), shipId, "env");

/** Copy the ship's `env` entries from this host's store into a worktree; says what was missing. */
export async function copyRigEnv(shipId: string, rig: RigDecl, cwd: string): Promise<{ ok: boolean; message: string }> {
  const missing: string[] = [];
  for (const rel of rig.env) {
    const src = join(rigStore(shipId), rel);
    if (!(await stat(src).catch(() => null))) {
      missing.push(rel);
      continue;
    }
    await cp(src, join(cwd, rel), { recursive: true, force: true, mode: 0 });
  }
  if (missing.length) return { ok: false, message: `missing from ${rigStore(shipId)}: ${missing.join(", ")}` };
  return { ok: true, message: `${rig.env.length} env entr${rig.env.length === 1 ? "y" : "ies"} copied` };
}
