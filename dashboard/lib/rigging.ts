import type { ShipRow } from "./fleet-layers.ts";
import { notifyCaptain } from "./notify.ts";
import { copyRigEnv, freePort, previewUrl, rigProject, type RigRecord } from "./rig.ts";
import { runCheck } from "./ship-checks.ts";
import type { HostKind } from "./ship-host.ts";
import { logShipEvent } from "./ship-log.ts";
import { rigPortsOn, updateVoyageRig, voyageHost, voyageWorktree } from "./voyage-worktree.ts";

/**
 * Rigging a voyage (lib/rig.ts has the contract): at Set sail the voyage gets
 * a Compose project and a port on its host, the brief is held, and the rig
 * runs (env files from the host's store, then the `rig` check: up steps and
 * the ready probe). Ready: the brief goes to the crew with the preview URL.
 * Failed: the captain gets a notice with the failing output; Rig again on the
 * deck (or the crew's `rig` maneuver) retries. Dock and move run `rig-down`.
 */

export type Deliver = (to: string, text: string) => Promise<void>;
type Deps = { runCheck: typeof runCheck; notify: typeof notifyCaptain };
const live: Deps = { runCheck, notify: notifyCaptain };

const rigging = new Set<string>();

/** Give the open voyage its project and port on `host` (after the worktree lease); null when the ship declares no rig. */
export function planRig(ship: Pick<ShipRow, "id" | "rig">, slug: string, host: HostKind): RigRecord | { error: string } | null {
  if (!ship.rig) return null;
  const port = freePort(rigPortsOn(host));
  if (port === null) return { error: "every rig port on that host is taken (4100–4199); dock a voyage first" };
  const short = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "voyage";
  return updateVoyageRig(ship.id, { project: rigProject(ship.id, short), port, slug: short, preview: previewUrl(ship.rig.ready, port), state: "pending", message: "" });
}

/** The lines a rigged voyage's brief gains: where the app runs and how to set it up again. */
export function rigBrief(rec: RigRecord): string {
  return `The voyage's own copy of the app is rigged${rec.preview ? ` and running at ${rec.preview}` : ""} (Docker Compose project ${rec.project}, migrated and seeded). Your shells have COMPOSE_PROJECT_NAME, FLEET_RIG_PORT, and FLEET_RIG_PREVIEW set, so docker compose commands and screenshots reach it; use that URL, never another stack. After a rebase, a new migration, or a broken stack, run the \`rig\` maneuver to set it up again; never set the stack up by hand.`;
}

/** Rig the open voyage's copy; delivers the held brief once it is ready. */
export async function rigVoyage(ship: ShipRow, deliver: Deliver | null, by = "helm", deps: Deps = live): Promise<{ ok: boolean; message: string }> {
  const w = voyageWorktree(ship.id);
  if (!ship.rig || !w?.rig) return { ok: false, message: `${ship.id} has no rigged voyage open.` };
  if (rigging.has(ship.id)) return { ok: false, message: `${ship.id}'s voyage is already being rigged.` };
  rigging.add(ship.id);
  const host = voyageHost(ship.id);
  const fail = (step: string, detail: string) => {
    const message = `${step}: ${detail.split("\n").slice(-1)[0]?.slice(0, 200) ?? ""}`;
    updateVoyageRig(ship.id, { state: "failed", message: detail.slice(-2000) });
    logShipEvent(ship.id, by, "rig", `Rigging failed at ${message}`, { project: w.rig!.project, step });
    deps.notify({ from: ship.id, kind: "blocked", summary: `${ship.id}'s voyage could not be rigged (${step}); the crew has not started. Fix it, then Rig again on the deck.`, detail: detail.slice(-3000), ref: `rig:${ship.id}` });
    return { ok: false, message: `Rigging ${ship.id} failed at ${message}` };
  };
  try {
    updateVoyageRig(ship.id, { state: "rigging", message: "" });
    logShipEvent(ship.id, by, "rig", `Rigging ${w.rig.project} on ${host.label}, port ${w.rig.port}`, { project: w.rig.project, port: w.rig.port });
    if (ship.rig.env.length) {
      const env = host.kind === "local" ? await copyRigEnv(ship.id, ship.rig, w.path) : host.copyRigEnv ? await host.copyRigEnv(ship.id, w.path).catch((e) => ({ ok: false, message: String(e) })) : { ok: false, message: `${host.label} cannot take rig env files` };
      if (!env.ok) return fail("env files", env.message);
    }
    const r = await deps.runCheck(ship.id, by, "rig");
    if (!r.ok) return fail("rig", r.message);
    const rec = updateVoyageRig(ship.id, { state: "ready", message: "" })!;
    logShipEvent(ship.id, by, "rig", `Rigged: ${rec.preview}`, { project: rec.project, preview: rec.preview });
    if (rec.brief && deliver) {
      await deliver(rec.brief.to, `${rec.brief.text}\n\n${rigBrief(rec)}`);
      updateVoyageRig(ship.id, { brief: null });
    }
    return { ok: true, message: `${ship.id}'s voyage is rigged: ${rec.preview}` };
  } catch (e) {
    return fail("rig", e instanceof Error ? e.message : String(e));
  } finally {
    rigging.delete(ship.id);
  }
}

/** Take the voyage's stack down (dock, move); never blocks the dock, only logs. */
export async function unrigVoyage(ship: ShipRow, deps: Pick<Deps, "runCheck"> = live): Promise<void> {
  const w = voyageWorktree(ship.id);
  if (!w?.rig || !ship.checks["rig-down"]) return;
  const r = await deps.runCheck(ship.id, "helm", "rig-down").catch((e) => ({ ok: false, message: String(e) }));
  if (!r.ok) logShipEvent(ship.id, "helm", "rig", `Taking ${w.rig.project} down failed; remove it by hand (docker compose -p ${w.rig.project} down -v): ${r.message.split("\n")[0]}`, { project: w.rig.project });
}
