import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Maneuvers: SSSF ADW runs on a ship, read (never written) from the ship
 * repo's adws/adw_data/sssf.db. Schema: the ship's adws/adw_modules/tracer.py.
 */

export type ManeuverPhase = { seq: number; name: string; owner: string; status: string; error: string | null; attempt: number };
export type Maneuver = {
  adwId: string;
  adwName: string;
  request: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  cost: number;
  phases: ManeuverPhase[];
};

export function shipTraceDb(shipPath: string): string {
  return join(shipPath, "adws", "adw_data", "sssf.db");
}

export function recentManeuvers(shipPath: string, limit = 6): Maneuver[] {
  const path = shipTraceDb(shipPath);
  if (!shipPath || !existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const sessions = db
      .query(
        "SELECT adw_id, adw_name, request, status, started_at, ended_at, total_cost FROM sessions WHERE COALESCE(archived, 0) = 0 ORDER BY started_at DESC LIMIT ?",
      )
      .all(limit) as { adw_id: string; adw_name: string | null; request: string | null; status: string | null; started_at: string | null; ended_at: string | null; total_cost: number | null }[];
    const phaseQ = db.query("SELECT seq, name, owner, status, error, attempt FROM phases WHERE adw_id = ? ORDER BY seq");
    return sessions.map((s) => ({
      adwId: s.adw_id,
      adwName: s.adw_name ?? "adw",
      request: s.request ?? "",
      status: s.status ?? "unknown",
      startedAt: s.started_at ?? "",
      endedAt: s.ended_at,
      cost: s.total_cost ?? 0,
      phases: (phaseQ.all(s.adw_id) as { seq: number; name: string | null; owner: string | null; status: string | null; error: string | null; attempt: number | null }[]).map((p) => ({
        seq: p.seq,
        name: p.name ?? "phase",
        owner: p.owner ?? "",
        status: p.status ?? "unknown",
        error: p.error,
        attempt: p.attempt ?? 0,
      })),
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
