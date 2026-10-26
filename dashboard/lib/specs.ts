import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { frontmatter } from "./fleet-layers.ts";
import { aliceVault } from "./paths.ts";

/**
 * Specs (vault plan fleet/plans/feature/design-sessions, D2): what a voyage
 * sails from. The fleet's architect writes one per decision into the vault,
 * fleet/specs/<ship>/<slug>.md, from a design or spec session's brief; the
 * captain approves it in the decision queue; a voyage then builds it (D3).
 *
 *   ---
 *   title: "Search page redesign"
 *   ship: kinwork
 *   status: draft | approved | sailing | built
 *   source: <the session record>
 *   prototype: design/search-page      # or none
 *   ---
 *   ## Goal / ## Scope / ## Non-goals / ## Acceptance criteria (- items, each checkable)
 *   ## Design / ## Technical approach / ## Task shape / ## Open questions
 */

export const SPEC_STATUSES = ["draft", "approved", "sailing", "built"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export type Spec = { file: string; ship: string; title: string; status: SpecStatus; source: string; prototype: string; criteria: string[] };

export const specsDir = (ship?: string) => join(aliceVault(), "fleet", "specs", ...(ship ? [ship] : []));

/** The items under "## Acceptance criteria" (checkboxes or bullets). */
export function acceptanceCriteria(text: string): string[] {
  const m = text.match(/^##\s+Acceptance criteria\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return (m?.[1] ?? "")
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

export function parseSpec(file: string): Spec | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = frontmatter(text) ?? {};
  const status = SPEC_STATUSES.includes(fm.status as SpecStatus) ? (fm.status as SpecStatus) : "draft";
  const prototype = String(fm.prototype ?? "").trim();
  return {
    file,
    ship: String(fm.ship ?? ""),
    title: String(fm.title ?? file.split("/").pop()!.replace(/\.md$/, "")),
    status,
    source: String(fm.source ?? ""),
    prototype: prototype === "none" ? "" : prototype,
    criteria: acceptanceCriteria(text),
  };
}

/** A path the architect submits: inside the vault's fleet/specs/<ship>/, for that ship, with criteria. */
export function checkSpec(path: string, ship?: string): { ok: true; spec: Spec } | { ok: false; message: string } {
  const abs = resolve(aliceVault(), path.replace(/^vault\//, ""));
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, message: `No spec at ${path}. Write it to fleet/specs/<ship>/<slug>.md in the vault.` };
  }
  const root = specsDir();
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  if (!real.startsWith(rootReal + sep) || !real.endsWith(".md")) return { ok: false, message: "Specs live in the vault under fleet/specs/<ship>/<slug>.md." };
  const spec = parseSpec(real);
  if (!spec) return { ok: false, message: `Could not read ${path}.` };
  if (!spec.ship || !real.startsWith(join(rootReal, spec.ship) + sep)) return { ok: false, message: "The spec's frontmatter needs ship: matching its folder (fleet/specs/<ship>/)." };
  if (ship && spec.ship !== ship) return { ok: false, message: `That spec is for ${spec.ship}, not ${ship}.` };
  if (!spec.criteria.length) return { ok: false, message: 'A spec needs "## Acceptance criteria" with at least one checkable item (- ...).' };
  return { ok: true, spec };
}

export function listSpecs(ship: string, status?: SpecStatus): Spec[] {
  let names: string[] = [];
  try {
    names = readdirSync(specsDir(ship)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names
    .map((n) => parseSpec(join(specsDir(ship), n)))
    .filter((s): s is Spec => Boolean(s) && (!status || s!.status === status))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Set a spec's status in its frontmatter (approved by the captain, sailing, built at dock). */
export function setSpecStatus(file: string, status: SpecStatus): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const next = /^status:\s*.*$/m.test(text.split(/^---\s*$/m)[1] ?? "") ? text.replace(/^status:\s*.*$/m, `status: ${status}`) : text.replace(/^---\s*$/m, `---\nstatus: ${status}`);
  writeFileSync(file, next, "utf8");
  return true;
}
