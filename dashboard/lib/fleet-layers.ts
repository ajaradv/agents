import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { aliceVault, ROOT } from "./paths.ts";
import { escapeHtml } from "./quota.ts";

/** One `fleet/ships/*.yaml` record plus the ADW chains found on disk. */
export type ShipRow = {
  id: string;
  path: string;
  mode: string;
  factory: string | null;
  declaredAdws: string[];
  adws: string[];
  /** Who runs voyages: "firstmate" today, "lead" for the fleet's own orchestrator. */
  orchestrator: string;
  /** Roles deployed aboard as `<ship>-<role>` crewmates (bin/launch resolve_crewmate). */
  crew: string[];
  crewModels: Record<string, string>;
};

/** One vault note under `{ALICE_VAULT}/fleet/initiatives/`. */
export type InitiativeRow = {
  slug: string;
  title: string;
  status: string;
  ships: string[];
  projects: string[];
  plans: string[];
};

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** ADW chain names (`adw_plan_build`, ...) from `<ship>/adws/adw_*.py`. */
export async function listShipAdws(shipPath: string): Promise<string[]> {
  try {
    const names = await readdir(join(shipPath, "adws"));
    return names
      .filter((n) => /^adw_[a-z0-9_]+\.py$/.test(n))
      .map((n) => n.replace(/\.py$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function parseShipYaml(text: string, fallbackId: string): Omit<ShipRow, "adws"> {
  const y = (yamlParse(text) ?? {}) as Record<string, unknown>;
  const factory = y.factory as { skill?: string; adws?: unknown } | null | undefined;
  return {
    id: String(y.id ?? fallbackId),
    path: String(y.path ?? ""),
    mode: String(y.mode ?? ""),
    factory: factory?.skill ? String(factory.skill) : null,
    declaredAdws: strList(factory?.adws),
    orchestrator: String(y.orchestrator ?? "firstmate"),
    crew: strList(y.crew).filter((r) => /^[a-z][a-z0-9_-]*$/.test(r)),
    crewModels: Object.fromEntries(
      Object.entries((y.crew_models as Record<string, unknown> | null) ?? {}).map(([k, v]) => [k, String(v)]),
    ),
  };
}

export async function readShips(dir = join(ROOT, "fleet", "ships")): Promise<ShipRow[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".yaml"));
  } catch {
    return [];
  }
  const rows: ShipRow[] = [];
  for (const name of names) {
    try {
      const base = parseShipYaml(await readFile(join(dir, name), "utf8"), name.replace(/\.yaml$/, ""));
      rows.push({ ...base, adws: base.path ? await listShipAdws(base.path) : [] });
    } catch {
      continue;
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** Split `---` frontmatter from a markdown note. Returns null when there is none. */
export function frontmatter(text: string): Record<string, unknown> | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m?.[1]) return null;
  try {
    const y = yamlParse(m[1]);
    return y && typeof y === "object" ? (y as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseInitiative(text: string, slug: string): InitiativeRow {
  const fm = frontmatter(text) ?? {};
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    slug,
    title: String(fm.title ?? heading ?? slug),
    status: String(fm.status ?? "active"),
    ships: strList(fm.ships).map((s) => s.toLowerCase()),
    projects: strList(fm.projects).map((s) => s.toLowerCase()),
    plans: strList(fm.plans),
  };
}

export function initiativesDir(): string {
  return join(aliceVault(), "fleet", "initiatives");
}

/** null = folder missing (layer hidden); [] = folder present but empty. */
export async function readInitiatives(dir = initiativesDir()): Promise<InitiativeRow[] | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return null;
  }
  const rows: InitiativeRow[] = [];
  for (const name of names) {
    try {
      rows.push(parseInitiative(await readFile(join(dir, name), "utf8"), name.replace(/\.md$/, "")));
    } catch {
      continue;
    }
  }
  const order = (s: string) => (s === "active" ? 0 : s === "paused" ? 1 : 2);
  return rows.sort((a, b) => order(a.status) - order(b.status) || a.title.localeCompare(b.title));
}

function chips(items: string[]): string {
  return items.map((x) => `<span class="detent">${escapeHtml(x)}</span>`).join(" ");
}

export function shipCard(ship: ShipRow, firstmateProjects: Set<string>): string {
  const registered = firstmateProjects.has(ship.id);
  const factory = ship.factory
    ? `<p class="muted">Factory ${escapeHtml(ship.factory)}</p>`
    : `<p class="muted">No factory stamped</p>`;
  const adws =
    ship.adws.length > 0
      ? `<h4>ADW chains</h4><p class="row-wrap">${chips(ship.adws)}</p>`
      : ship.factory
        ? `<p class="warn">No adws/ found at ${escapeHtml(ship.path)}</p>`
        : "";
  return `<article class="sheet stack">
    <div class="between">
      <h3 class="sheet-title">${escapeHtml(ship.id)}</h3>
      <span class="detent">${escapeHtml(ship.mode || "mode unset")}</span>
    </div>
    <p class="muted path">${escapeHtml(ship.path)}</p>
    ${factory}
    ${adws}
    <p class="${registered ? "muted" : "warn"}">${registered ? "Registered with Firstmate" : "Not registered with Firstmate"}</p>
  </article>`;
}

export function initiativeCard(
  ini: InitiativeRow,
  activeCount: (projectId: string) => number,
): string {
  const linked = [...new Set([...ini.projects, ...ini.ships])];
  const inFlight = linked.reduce((n, id) => n + activeCount(id), 0);
  return `<article class="sheet stack">
    <div class="between">
      <h3>${escapeHtml(ini.title)}</h3>
      <span class="${ini.status === "active" ? "detent detent-hot" : "detent"}">${escapeHtml(ini.status)}</span>
    </div>
    ${ini.ships.length ? `<p class="row-wrap"><span class="muted">Ships</span> ${chips(ini.ships)}</p>` : ""}
    ${ini.projects.length ? `<p class="row-wrap"><span class="muted">Projects</span> ${chips(ini.projects)}</p>` : ""}
    ${ini.plans.length ? `<p class="muted">${ini.plans.length} plan${ini.plans.length === 1 ? "" : "s"}</p>` : ""}
    <p class="muted">${linked.length === 0 ? "No ships or projects linked." : inFlight === 0 ? "Nothing in flight." : `${inFlight} in flight`}</p>
  </article>`;
}

export function shipsSectionHtml(ships: ShipRow[], firstmateProjects: Set<string>): string {
  if (ships.length === 0) return "";
  return `<div class="between">
      <h3>Ships</h3>
      <span class="muted">${ships.length} in fleet/ships</span>
    </div>
    <div class="grid-2">${ships.map((s) => shipCard(s, firstmateProjects)).join("")}</div>`;
}

export function initiativesSectionHtml(
  initiatives: InitiativeRow[] | null,
  activeCount: (projectId: string) => number,
): string {
  if (initiatives === null) return "";
  const body =
    initiatives.length === 0
      ? `<p class="muted">No initiatives yet. Add notes under the vault's fleet/initiatives/.</p>`
      : `<div class="grid-2">${initiatives.map((i) => initiativeCard(i, activeCount)).join("")}</div>`;
  return `<div class="between">
      <h3>Initiatives</h3>
      <span class="muted">vault</span>
    </div>
    ${body}`;
}
