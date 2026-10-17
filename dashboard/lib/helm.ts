import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, type Document } from "yaml";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { journalDb } from "./journal.ts";
import { describeManeuver, maneuverAvailability } from "./maneuvers.ts";
import { metricsDb } from "./metrics.ts";
import { fleetInboxRoot } from "./paths.ts";
import { logShipEvent } from "./ship-log.ts";
import { editShip } from "./shipyard.ts";

/**
 * The helmsman (vault research note helm-and-maneuvers): keeps a ship's
 * process fit as the project grows. Code does the mechanical part: a digest
 * of the ship's process and what the record shows (repo signals, check and
 * maneuver history, repeated check patterns, unused maneuvers, blocked hosts,
 * tool failures). The helmsman, a cheap read-only crewmate, judges it after a
 * voyage docks or when the captain asks, and files proposals with helm_propose.
 * Nothing changes the ship file until the captain applies a proposal on the
 * deck (agent proposes, code disposes, the captain decides).
 */

export type ProposalKind = "check" | "gate" | "maneuver" | "retire_maneuver" | "allow_host" | "note";
export type Proposal = {
  id: string;
  ts: string;
  by: string;
  kind: ProposalKind;
  why: string;
  status: "open" | "applied" | "dismissed";
  // check
  name?: string;
  command?: string;
  // gate
  stage?: "task" | "dock";
  check?: string;
  // maneuver
  checks?: string[];
  adw?: string;
  roles?: string[];
  needs?: string[];
  gates?: ("task" | "dock")[];
  // allow_host
  host?: string;
  // note
  text?: string;
};

const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]*$/;
const HOST_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DAYS = 30;

const proposalsFile = (ship: string) => join(fleetInboxRoot(), "ships", ship, "helm-proposals.json");

export async function listProposals(ship: string): Promise<Proposal[]> {
  try {
    const j = JSON.parse(await readFile(proposalsFile(ship), "utf8"));
    return Array.isArray(j) ? (j as Proposal[]) : [];
  } catch {
    return [];
  }
}

/** One change to a ship's proposals at a time: a helmsman files several in parallel tool calls. */
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(ship: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(ship) ?? Promise.resolve()).then(fn, fn);
  locks.set(ship, run.catch(() => undefined));
  return run;
}

async function saveProposals(ship: string, all: Proposal[]): Promise<void> {
  await mkdir(join(fleetInboxRoot(), "ships", ship), { recursive: true });
  // Keep the open ones and the latest 50 settled ones.
  const open = all.filter((p) => p.status === "open");
  const settled = all.filter((p) => p.status !== "open").slice(-50);
  await writeFile(proposalsFile(ship), `${JSON.stringify([...settled, ...open], null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------- digest

/** Build manifests at the repo root, and the justfile's recipes: what a check could cover. */
export function repoSignals(path: string): { manifests: string[]; recipes: string[] } {
  const known = ["pyproject.toml", "package.json", "Cargo.toml", "go.mod", "justfile", "Justfile", "Makefile", ".pre-commit-config.yaml", "docker-compose.yml", "docker-compose.local.yml", "compose.yaml", "mypy.ini", "ruff.toml", "tsconfig.json"];
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {
    return { manifests: [], recipes: [] };
  }
  const manifests = known.filter((k) => names.includes(k));
  let recipes: string[] = [];
  const just = ["justfile", "Justfile"].find((j) => names.includes(j));
  if (just) {
    try {
      recipes = [...readFileSync(join(path, just), "utf8").matchAll(/^([a-z][a-z0-9_-]*)(?:\s+[^:\n=]*)?:(?!=)/gm)].map((m) => m[1]!).slice(0, 60);
    } catch {
      /* unreadable */
    }
  }
  return { manifests, recipes: [...new Set(recipes)] };
}

export type HelmRecord = {
  runs: { kind: string; name: string; runs: number; passed: number; avgMs: number }[];
  patterns: { checks: string; voyages: number }[];
  unused: string[];
  blocked: { host: string; n: number }[];
  failures: { agent: string; tool: string; n: number }[];
  voyages: number;
};

/** What the record shows for a ship over the last 30 days. */
export function helmRecord(ship: ShipRow): HelmRecord {
  const from = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const m = metricsDb();
  const runs = m
    .query("SELECT kind, name, COUNT(*) AS runs, SUM(ok) AS passed, ROUND(AVG(ms)) AS avgMs FROM runs WHERE ship = ? AND ts >= ? GROUP BY kind, name ORDER BY runs DESC")
    .all(ship.id, from) as HelmRecord["runs"];
  // The set of checks each voyage ran (in first-run order): the same set voyage after voyage is a maneuver waiting to be declared.
  const perVoyage = m
    .query("SELECT voyage, group_concat(name, ' ') AS names FROM (SELECT voyage, name, MIN(id) AS first FROM runs WHERE ship = ? AND kind = 'check' AND voyage IS NOT NULL AND ts >= ? GROUP BY voyage, name ORDER BY voyage, first) GROUP BY voyage")
    .all(ship.id, from) as { voyage: string; names: string }[];
  const counts = new Map<string, number>();
  for (const v of perVoyage) if (v.names.includes(" ")) counts.set(v.names, (counts.get(v.names) ?? 0) + 1);
  const patterns = [...counts].map(([checks, voyages]) => ({ checks, voyages })).sort((a, b) => b.voyages - a.voyages);
  const ran = new Set(runs.filter((r) => r.kind === "maneuver").map((r) => r.name));
  const unused = ship.maneuvers.filter((d) => !ran.has(d.name)).map((d) => d.name);
  const voyages = (m.query("SELECT COUNT(*) AS n FROM voyages WHERE ship = ? AND started >= ?").get(ship.id, from) as { n: number }).n;
  const crew = ship.crew.map((r) => `${ship.id}-${r}`);
  let blocked: HelmRecord["blocked"] = [];
  let failures: HelmRecord["failures"] = [];
  if (crew.length) {
    const marks = crew.map(() => "?").join(",");
    try {
      const j = journalDb();
      blocked = j.query(`SELECT args AS host, COUNT(*) AS n FROM tool_failures WHERE tool = 'network' AND agent IN (${marks}) AND ts >= ? GROUP BY args ORDER BY n DESC LIMIT 20`).all(...crew, from) as HelmRecord["blocked"];
      failures = j.query(`SELECT agent, tool, COUNT(*) AS n FROM tool_failures WHERE tool NOT IN ('network') AND agent IN (${marks}) AND ts >= ? GROUP BY agent, tool ORDER BY n DESC LIMIT 15`).all(...crew, from) as HelmRecord["failures"];
    } catch {
      /* no failure log yet */
    }
  }
  return { runs, patterns, unused, blocked, failures, voyages };
}

/** The helmsman's brief: the ship's process and what the record shows, as plain markdown. */
export function helmDigest(ship: ShipRow, reason: string, ledger = ""): string {
  const sig = repoSignals(ship.path);
  const rec = helmRecord(ship);
  const all = maneuverAvailability(ship, "lead");
  const lines = [
    `Helm review for ${ship.id}: ${reason}`,
    "",
    "Review the ship's process against the record below and file proposals with helm_propose (one call per proposal). Read the repo (read-only) to confirm what a check should run before proposing it. Propose only what the record or the repo supports; nothing is better than a guess. When you are done, end your turn with a two-line summary.",
    "",
    "## The ship's process",
    "",
    `- Crew: ${ship.crew.join(", ") || "none"}; isolation: ${ship.isolation}`,
    `- Checks: ${Object.entries(ship.checks).map(([k, v]) => `${k} (\`${v}\`)`).join("; ") || "none"}`,
    `- Gates: task ${ship.gates.task.join(", ") || "none"}; dock ${ship.gates.dock.join(", ") || "none"}`,
    `- Maneuvers: ${all.length ? all.map(describeManeuver).join("; ") : "none"}`,
    `- VM network allowlist: ${ship.isolation === "vm" ? ship.vmAllow.join(", ") : "(not in a VM)"}`,
    "",
    "## The repo",
    "",
    `- Build files at the root: ${sig.manifests.join(", ") || "none found"}`,
    `- justfile recipes: ${sig.recipes.join(", ") || "none"}`,
    "",
    `## The record (last ${DAYS} days, ${rec.voyages} voyage${rec.voyages === 1 ? "" : "s"})`,
    "",
    `- Runs: ${rec.runs.length ? rec.runs.map((r) => `${r.kind} ${r.name} ${r.passed}/${r.runs} passed, ~${Math.round(r.avgMs / 1000)}s`).join("; ") : "none"}`,
    `- Check sets run together in one voyage: ${rec.patterns.length ? rec.patterns.map((p) => `[${p.checks}] in ${p.voyages} voyage${p.voyages === 1 ? "" : "s"}`).join("; ") : "none"}`,
    `- Declared maneuvers never run: ${rec.unused.join(", ") || "none"}`,
    `- Hosts the VM blocked: ${rec.blocked.length ? rec.blocked.map((b) => `${b.host} (${b.n})`).join(", ") : "none"}`,
    `- Tool failures by crewmate: ${rec.failures.length ? rec.failures.map((f) => `${f.agent} ${f.tool} (${f.n})`).join(", ") : "none"}`,
  ];
  if (ledger) lines.push("", "## The voyage that just docked", "", ledger.replace(/^## Ledger\n+/, ""));
  return lines.join("\n");
}

// ---------------------------------------------------------------- proposals

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** Validate a helmsman's proposal against the ship; returns the proposal or why not. */
export function validateProposal(ship: ShipRow, b: Record<string, unknown>, open: Proposal[]): Omit<Proposal, "id" | "ts" | "by" | "status"> | string {
  const kind = String(b.kind ?? "") as ProposalKind;
  const why = String(b.why ?? "").trim().slice(0, 600);
  if (why.length < 10) return "Say why (what in the record or the repo supports it).";
  const pendingChecks = open.filter((p) => p.kind === "check").map((p) => p.name!);
  const knownCheck = (c: string) => Boolean(ship.checks[c]) || pendingChecks.includes(c);
  switch (kind) {
    case "check": {
      const name = String(b.name ?? "").trim();
      const command = String(b.command ?? "").trim();
      if (!NAME_RE.test(name)) return "A check name is lowercase letters, digits, - and _.";
      if (ship.checks[name]) return `${ship.id} already has a check named ${name}.`;
      if (!command || command.length > 300 || /[\n\r]/.test(command)) return "A check command is one line, at most 300 characters.";
      return { kind, why, name, command };
    }
    case "gate": {
      const stage = String(b.stage ?? "");
      const check = String(b.check ?? "").trim();
      if (stage !== "task" && stage !== "dock") return "A gate's stage is task or dock.";
      if (!knownCheck(check)) return `${check} is not a check of ${ship.id} (propose the check first).`;
      if (ship.gates[stage].includes(check)) return `${check} already gates ${stage}.`;
      return { kind, why, stage, check };
    }
    case "maneuver": {
      const name = String(b.name ?? "").trim();
      const checks = list(b.checks);
      const adw = String(b.adw ?? "").trim();
      if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name)) return "A maneuver name is lowercase letters, digits, - and _.";
      if (ship.maneuvers.some((m) => m.name === name)) return `${ship.id} already declares ${name}.`;
      if (Boolean(checks.length) === Boolean(adw)) return "A maneuver runs either checks or an adw, not both.";
      for (const c of checks) if (!knownCheck(c)) return `${c} is not a check of ${ship.id}.`;
      if (adw && !ship.adws.includes(adw)) return `${adw} is not in the repo's adws/.`;
      const roles = list(b.roles).filter((r) => ROLE_RE.test(r));
      const needs = list(b.needs).filter((r) => ROLE_RE.test(r));
      const gates = list(b.gates).filter((g): g is "task" | "dock" => g === "task" || g === "dock");
      return { kind, why, name, ...(checks.length ? { checks } : { adw }), roles: roles.length ? roles : ["lead"], needs, gates };
    }
    case "retire_maneuver": {
      const name = String(b.name ?? "").trim();
      if (!ship.maneuvers.some((m) => m.name === name)) return `${ship.id} declares no maneuver ${name}.`;
      return { kind, why, name };
    }
    case "allow_host": {
      const host = String(b.host ?? "").trim().toLowerCase();
      if (ship.isolation !== "vm") return `${ship.id}'s crew does not run in VMs; there is no allowlist.`;
      if (!HOST_RE.test(host)) return "A host is a hostname such as api.github.com (or *.example.com).";
      if (ship.vmAllow.includes(host)) return `${host} is already allowed.`;
      return { kind, why, host };
    }
    case "note": {
      const text = String(b.text ?? "").trim().slice(0, 1000);
      if (text.length < 10) return "A note needs text.";
      return { kind, why, text };
    }
    default:
      return "kind is one of check, gate, maneuver, retire_maneuver, allow_host, note.";
  }
}

const same = (a: Partial<Proposal>, b: Partial<Proposal>) =>
  a.kind === b.kind && a.name === b.name && a.stage === b.stage && a.check === b.check && a.host === b.host && (a.kind !== "note" || a.text === b.text);

/** A helmsman's proposal (crew API, helm_propose). */
export function helmPropose(shipId: string, from: string, b: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  return withLock(shipId, () => proposeNow(shipId, from, b));
}

async function proposeNow(shipId: string, from: string, b: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship) return { ok: false, message: `No ship ${shipId}.` };
  if (from !== `${shipId}-helmsman` || !ship.crew.includes("helmsman")) return { ok: false, message: "Only the ship's helmsman files helm proposals." };
  const all = await listProposals(shipId);
  const open = all.filter((p) => p.status === "open");
  const v = validateProposal(ship, b, open);
  if (typeof v === "string") return { ok: false, message: v };
  if (open.some((p) => same(p, v))) return { ok: false, message: "That proposal is already open on the deck." };
  const p: Proposal = { ...v, id: randomBytes(3).toString("hex"), ts: new Date().toISOString(), by: from, status: "open" };
  await saveProposals(shipId, [...all, p]);
  logShipEvent(shipId, from, "helm", `Proposed: ${proposalLine(p)}`, { proposal: p.id });
  return { ok: true, message: `Proposal ${p.id} is on the deck for the captain: ${proposalLine(p)}.` };
}

/** One line describing a proposal. */
export function proposalLine(p: Proposal): string {
  switch (p.kind) {
    case "check":
      return `add check ${p.name}: ${p.command}`;
    case "gate":
      return `gate ${p.stage} on ${p.check}`;
    case "maneuver":
      return `declare maneuver ${p.name} (${p.checks?.length ? `checks ${p.checks.join(" → ")}` : `adw ${p.adw}`}, by ${(p.roles ?? ["lead"]).join(", ")}${p.needs?.length ? `, needs ${p.needs.join(", ")}` : ""}${p.gates?.length ? `, gates ${p.gates.join(", ")}` : ""})`;
    case "retire_maneuver":
      return `retire maneuver ${p.name}`;
    case "allow_host":
      return `allow ${p.host} from the crew's VMs`;
    case "note":
      return `note: ${p.text}`;
  }
}

/** A proposal's change to a parsed ship file (yaml Document): comments and the captain's other keys stay as they are. */
export function applyToDoc(doc: Document, p: Proposal, ship: Pick<ShipRow, "vmAllow">): void {
  const appendTo = (path: string[], value: string) => {
    const cur = doc.getIn(path);
    const items = isSeq(cur) ? (cur.toJSON() as string[]) : Array.isArray(cur) ? (cur as string[]) : [];
    doc.setIn(path, doc.createNode([...items, value]));
  };
  if (p.kind === "check") doc.setIn(["checks", p.name!], p.command!);
  else if (p.kind === "gate") appendTo(["gates", p.stage!], p.check!);
  else if (p.kind === "maneuver") {
    doc.setIn(["maneuvers", p.name!], doc.createNode({
      ...(p.checks?.length ? { checks: p.checks } : { adw: p.adw }),
      by: p.roles ?? ["lead"],
      ...(p.needs?.length ? { needs: p.needs } : {}),
      ...(p.gates?.length ? { gates: p.gates } : {}),
    }));
  } else if (p.kind === "retire_maneuver") {
    if (isMap(doc.get("maneuvers"))) doc.deleteIn(["maneuvers", p.name!]);
  } else if (p.kind === "allow_host") {
    // A ship without vm_allow uses the default list: write it out so adding one host keeps the rest.
    if (!isSeq(doc.get("vm_allow"))) doc.set("vm_allow", doc.createNode([...ship.vmAllow]));
    appendTo(["vm_allow"], p.host!);
  }
}

/** The captain applies a proposal: the ship file changes. */
export function applyProposal(shipId: string, id: string): Promise<{ ok: boolean; message: string }> {
  return withLock(shipId, () => applyNow(shipId, id));
}

async function applyNow(shipId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship) return { ok: false, message: `No ship ${shipId}.` };
  const all = await listProposals(shipId);
  const p = all.find((x) => x.id === id && x.status === "open");
  if (!p) return { ok: false, message: "That proposal is no longer open." };
  if (p.kind === "note") return { ok: false, message: "A note has nothing to apply; dismiss it when read." };
  // Re-check against the ship as it is now (it may have changed since the proposal).
  const again = validateProposal(ship, p as unknown as Record<string, unknown>, all.filter((x) => x.status === "open" && x.id !== id));
  if (typeof again === "string") return { ok: false, message: `Cannot apply: ${again}` };
  await editShip(shipId, (doc) => applyToDoc(doc, p, ship));
  p.status = "applied";
  await saveProposals(shipId, all);
  logShipEvent(shipId, "captain", "helm", `Applied: ${proposalLine(p)}`, { proposal: p.id });
  return { ok: true, message: `Applied: ${proposalLine(p)}. Crewmates pick it up at their next start.` };
}

export function dismissProposal(shipId: string, id: string): Promise<{ ok: boolean; message: string }> {
  return withLock(shipId, () => dismissNow(shipId, id));
}

async function dismissNow(shipId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const all = await listProposals(shipId);
  const p = all.find((x) => x.id === id && x.status === "open");
  if (!p) return { ok: false, message: "That proposal is no longer open." };
  p.status = "dismissed";
  await saveProposals(shipId, all);
  logShipEvent(shipId, "captain", "helm", `Dismissed: ${proposalLine(p)}`, { proposal: p.id });
  return { ok: true, message: "Dismissed." };
}

export function hasHelmsman(ship: Pick<ShipRow, "crew">): boolean {
  return ship.crew.includes("helmsman");
}

