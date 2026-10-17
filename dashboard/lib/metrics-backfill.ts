import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatter } from "./fleet-layers.ts";
import { metricsDb, roleOf, shipMode, voyageId } from "./metrics.ts";
import { aliceVault, fleetInboxRoot } from "./paths.ts";

/**
 * Fill the fleet metrics database with what happened before it existed, so
 * dashboards have history from day one: voyages from the vault notes, turns,
 * check runs, and crew messages from every ship log (ship logs never stored a
 * model, so backfilled turns have none). Runs once per database (a meta key);
 * the node calls it at start.
 */

const META = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

export function backfillMetrics(opts: { inbox?: string; vault?: string } = {}): { voyages: number; turns: number; runs: number; handoffs: number } | null {
  const d = metricsDb();
  d.exec(META);
  if (d.query("SELECT value FROM meta WHERE key = 'backfilled'").get()) return null;
  const inbox = opts.inbox ?? fleetInboxRoot();
  const vault = opts.vault ?? aliceVault();
  const counts = { voyages: 0, turns: 0, runs: 0, handoffs: 0 };

  // Voyages, from the vault notes (started/ended in frontmatter).
  const windows: { id: string; ship: string; from: string; to: string }[] = [];
  const vdir = join(vault, "fleet", "voyages");
  for (const ship of existsSync(vdir) ? readdirSync(vdir) : []) {
    for (const f of readdirSync(join(vdir, ship)).filter((n) => n.endsWith(".md"))) {
      const fm = frontmatter(readFileSync(join(vdir, ship, f), "utf8")) ?? {};
      const started = fm.started ? new Date(String(fm.started)).toISOString() : "";
      if (!started) continue;
      const ended = fm.ended ? new Date(String(fm.ended)).toISOString() : null;
      const id = voyageId(f);
      const r = d
        .query("INSERT OR IGNORE INTO voyages (id, ship, goal, sent_to, branch, worktree, started, docked, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')")
        .run(id, String(fm.ship ?? ship), String(fm.goal ?? "").slice(0, 500), String(fm.to ?? ""), String(fm.branch ?? ""), String(fm.worktree ?? ""), started, ended);
      counts.voyages += r.changes;
      windows.push({ id, ship: String(fm.ship ?? ship), from: started, to: ended ?? "9999" });
    }
  }
  const voyageAt = (ship: string, ts: string) => windows.find((w) => w.ship === ship && ts >= w.from && ts <= w.to)?.id ?? null;

  // Turns, checks, and crew messages, from each ship's log.
  const sdir = join(inbox, "ships");
  for (const ship of existsSync(sdir) ? readdirSync(sdir) : []) {
    const path = join(sdir, ship, "ship.db");
    if (!existsSync(path)) continue;
    const src = new Database(path, { readonly: true });
    try {
      const rows = src.query("SELECT ts, actor, kind, summary, payload_json FROM events WHERE kind IN ('turn-end', 'check', 'crew') ORDER BY id").all() as { ts: string; actor: string; kind: string; summary: string; payload_json: string | null }[];
      const mode = shipMode(ship);
      const crewShip = ship === "fleet" ? "" : ship;
      for (const e of rows) {
        let p: Record<string, unknown> = {};
        try {
          p = JSON.parse(e.payload_json ?? "{}");
        } catch {
          /* no payload */
        }
        const v = voyageAt(ship, e.ts);
        if (e.kind === "turn-end") {
          const failed = e.summary.startsWith("Turn failed");
          d.query("INSERT INTO turns (ts, agent, role, ship, voyage, model, mode, ok, ms, cost, tokens, cache_read, prompt, error) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)").run(
            e.ts, e.actor, roleOf(e.actor, crewShip), crewShip, v, crewShip ? mode : "host", failed ? 0 : 1,
            Number(p.ms) || 0, Number(p.cost) || 0, Number(p.tokens) || 0, Number(p.cacheRead) || 0, Number(p.prompt) || 0, failed ? e.summary.slice(0, 300) : "",
          );
          counts.turns++;
        } else if (e.kind === "check" && typeof p.name === "string" && (p.exitCode !== undefined || p.timedOut !== undefined)) {
          d.query("INSERT INTO runs (ts, ship, voyage, agent, kind, name, deterministic, ok, ms, cost, detail) VALUES (?, ?, ?, ?, 'check', ?, 1, ?, ?, 0, ?)").run(
            e.ts, ship, v, e.actor, p.name, p.exitCode === 0 && !p.timedOut ? 1 : 0, (Number(p.secs) || 0) * 1000, e.summary.slice(0, 300),
          );
          counts.runs++;
        } else if (e.kind === "crew") {
          const to = e.summary.match(/^→ ([a-z0-9_-]+):/)?.[1] ?? "";
          d.query("INSERT INTO handoffs (ts, ship, voyage, from_agent, to_agent, kind, size) VALUES (?, ?, ?, ?, ?, 'message', ?)").run(e.ts, ship, v, e.actor, to, e.summary.length);
          counts.handoffs++;
        }
      }
    } finally {
      src.close();
    }
  }
  d.query("INSERT INTO meta (key, value) VALUES ('backfilled', ?)").run(new Date().toISOString());
  return counts;
}
