import type { GateStage } from "./gates.ts";

/**
 * Maneuver declarations (vault research note helm-and-maneuvers): what a
 * maneuver runs, who may launch it, and what the ship must have before it is
 * unlocked, in fleet/ships/<ship>.yaml:
 *
 *   maneuvers:
 *     verify:                  # deterministic: the ship's checks in order, stopping at the first failure
 *       checks: [lint, pytest, frontend]
 *       by: [lead, scout, designer]
 *     build:                   # an SSSF ADW from the repo's adws/
 *       adw: adw_plan_build_test
 *       needs: [designer]      # roles that must be aboard
 *       gates: [task]          # gate stages the ship must declare; they must pass before it counts as done
 *     release:
 *       adw: adw_ship
 *       go: true               # only on the captain's Go, never by a crewmate
 *
 * `by` defaults to the lead. ADWs in the repo that no declaration names stay
 * available to the lead as before. The node enforces all of it at launch:
 * a crewmate cannot start a maneuver its role is not given, and nobody can
 * start one that is locked.
 */

export type ManeuverDecl = {
  name: string;
  kind: "checks" | "adw";
  checks: string[];
  adw: string | null;
  by: string[];
  needs: string[];
  gates: GateStage[];
  go: boolean;
  /** Declared in the ship file (false: an ADW found in the repo and nobody declared it). */
  declared: boolean;
};

export type ManeuverAvailability = ManeuverDecl & {
  /** Unlocked: everything it needs is on the ship. */
  unlocked: boolean;
  /** Why it is locked (empty when unlocked). */
  locked: string[];
  /** The asking role may launch it itself (unlocked, named in `by`, no Go needed). */
  yours: boolean;
};

const NAME_RE = /^[a-z][a-z0-9_-]{0,40}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]*$/;
export const ADW_RE = /^adw_[a-z0-9_]+$/;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);

/** Parse the `maneuvers:` map of a ship file. Malformed entries are dropped. */
export function parseManeuvers(raw: unknown): ManeuverDecl[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: ManeuverDecl[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || !v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    const checks = list(m.checks);
    const adw = typeof m.adw === "string" && ADW_RE.test(m.adw.trim()) ? m.adw.trim() : null;
    // Exactly one of checks or adw.
    if (Boolean(checks.length) === Boolean(adw)) continue;
    const by = list(m.by).filter((r) => ROLE_RE.test(r));
    out.push({
      name,
      kind: adw ? "adw" : "checks",
      checks,
      adw,
      by: by.length ? by : ["lead"],
      needs: list(m.needs).filter((r) => ROLE_RE.test(r)),
      gates: list(m.gates).filter((g): g is GateStage => g === "task" || g === "dock"),
      go: m.go === true,
      declared: true,
    });
  }
  return out;
}

type ShipLike = { crew: string[]; checks: Record<string, string>; gates: { task: string[]; dock: string[] }; adws: string[]; maneuvers: ManeuverDecl[] };

/** Every maneuver of a ship: its declarations, then repo ADWs nobody declared (lead only, as before). */
export function shipManeuverList(ship: ShipLike): ManeuverDecl[] {
  const named = new Set(ship.maneuvers.flatMap((m) => [m.name, ...(m.adw ? [m.adw] : [])]));
  const implicit: ManeuverDecl[] = ship.adws
    .filter((a) => !named.has(a))
    .map((a) => ({ name: a, kind: "adw", checks: [], adw: a, by: ["lead"], needs: [], gates: [], go: false, declared: false }));
  return [...ship.maneuvers, ...implicit];
}

/** Which maneuvers are unlocked on the ship, and which the role may launch itself. */
export function maneuverAvailability(ship: ShipLike, role: string): ManeuverAvailability[] {
  return shipManeuverList(ship).map((m) => {
    const locked: string[] = [];
    for (const r of m.needs) if (!ship.crew.includes(r)) locked.push(`needs a ${r} aboard`);
    for (const g of m.gates) if (!ship.gates[g].length) locked.push(`needs the ship to declare ${g} gates`);
    for (const c of m.checks) if (!ship.checks[c]) locked.push(`check ${c} is not one of the ship's checks`);
    if (m.adw && !ship.adws.includes(m.adw)) locked.push(`${m.adw} is not in the repo's adws/`);
    const unlocked = locked.length === 0;
    return { ...m, unlocked, locked, yours: unlocked && !m.go && m.by.includes(role) };
  });
}

/** Find a maneuver by its name or its ADW (older calls name the ADW). */
export function findManeuver(all: ManeuverAvailability[], name: string): ManeuverAvailability | undefined {
  return all.find((m) => m.name === name) ?? all.find((m) => m.adw === name);
}

/** One line per maneuver, for prompts and status. */
export function describeManeuver(m: ManeuverAvailability): string {
  const what = m.kind === "checks" ? `checks ${m.checks.join(" → ")} (deterministic)` : `SSSF ${m.adw}`;
  const who = m.go ? "captain's Go only" : `by ${m.by.join(", ")}`;
  const gates = m.gates.length ? `; must pass ${m.gates.join(" and ")} gates` : "";
  return `${m.name}: ${what}, ${who}${gates}${m.unlocked ? "" : `; locked: ${m.locked.join(", ")}`}`;
}

/**
 * May `role` launch `m`? With the captain's Go, the role does not matter (the
 * captain authorised it), but a locked maneuver stays locked.
 */
export function launchRefusal(m: ManeuverAvailability, role: string, withGo: boolean): string | null {
  if (!m.unlocked) return `Maneuver ${m.name} is locked: ${m.locked.join("; ")}.`;
  if (withGo) return null;
  if (m.go) return `Maneuver ${m.name} runs only on the captain's Go. Ask the captain (ask_captain) if it is needed.`;
  if (!m.by.includes(role)) return `Maneuver ${m.name} is launched by ${m.by.join(", ")}, not by a ${role}. Ask the lead.`;
  return null;
}
