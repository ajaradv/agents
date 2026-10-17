import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isMap, parseDocument, parse as yamlParse } from "yaml";
import { metricsDb } from "./metrics.ts";
import { nodeStateDir, ROOT } from "./paths.ts";

/**
 * Ship config layers (vault research note ship-config-layers):
 *
 * - **Base**, committed: fleet/ships/<ship>.yaml. Setup (id, path, mode,
 *   factory, isolation, env, authority) and defaults for everything else.
 * - **Overlay**, gitignored and machine-local: fleet/home/ships/<ship>.yaml.
 *   What changes at run time: crew, budgets, models, orchestrator, gates,
 *   maneuvers, checks the helmsman adds, allowed hosts. The shipyard and the
 *   helmsman's Apply write here, never to the base; the captain may edit it.
 * - **Merged view**: base, then overlay on top. Maps merge key by key, lists
 *   and values replace, `null` deletes. Every reader uses it, and the node
 *   writes it as JSON to fleet/inbox/.node/ships/<ship>.json for bin/launch.
 * - **Change log**: every write records what changed, old and new, who, and
 *   why (config_changes in the metrics database).
 */

type Obj = Record<string, unknown>;

export const baseDir = () => process.env.FLEET_SHIPS_DIR ?? join(ROOT, "fleet", "ships");
export const overlayDir = () => process.env.FLEET_SHIP_OVERLAY_DIR ?? join(ROOT, "fleet", "home", "ships");
export const mergedDir = () => join(nodeStateDir(), "ships");
const baseFile = (id: string) => join(baseDir(), `${id}.yaml`);
const overlayFile = (id: string) => join(overlayDir(), `${id}.yaml`);

/** Starting setups for new ships (fleet/ship-templates/<name>.yaml), for bin/stamp-ship --template. */
export function shipTemplates(): string[] {
  try {
    return readdirSync(join(ROOT, "fleet", "ship-templates")).filter((n) => n.endsWith(".yaml")).map((n) => n.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Overlay on top of base: maps merge key by key, everything else replaces, null deletes. */
export function mergeConfig(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base;
  if (!isObj(base) || !isObj(overlay)) return overlay;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === null) delete out[k];
    else out[k] = mergeConfig(base[k], v);
  }
  return out;
}

/** What changed from `before` to `after`, as overlay entries (path, new value; null = removed). */
export function configDiff(before: unknown, after: unknown, path: string[] = []): { path: string[]; old: unknown; value: unknown }[] {
  if (isObj(before) && isObj(after)) {
    const out: { path: string[]; old: unknown; value: unknown }[] = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(k in after)) out.push({ path: [...path, k], old: before[k], value: null });
      else out.push(...configDiff(before[k], after[k], [...path, k]));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, old: before, value: after }];
}

function readYaml(path: string): Obj {
  try {
    const y = yamlParse(readFileSync(path, "utf8"));
    return isObj(y) ? y : {};
  } catch {
    return {};
  }
}

/** A ship's merged config (base plus overlay), or null when the ship has no base file. */
export function readShipConfig(id: string): Obj | null {
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(id) || !existsSync(baseFile(id))) return null;
  return mergeConfig(readYaml(baseFile(id)), existsSync(overlayFile(id)) ? readYaml(overlayFile(id)) : undefined) as Obj;
}

/** Write the merged view for bin/launch (it reads JSON, not YAML). */
export function materializeShip(id: string): void {
  const merged = readShipConfig(id);
  if (!merged) return;
  try {
    mkdirSync(mergedDir(), { recursive: true });
    writeFileSync(join(mergedDir(), `${id}.json`), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  } catch (e) {
    console.error("[ship-config]", e instanceof Error ? e.message : e);
  }
}

export function materializeAllShips(ids: string[]): void {
  for (const id of ids) materializeShip(id);
}

const LOG = `CREATE TABLE IF NOT EXISTS config_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ship TEXT NOT NULL, key TEXT NOT NULL,
  old TEXT, new TEXT, by TEXT NOT NULL, why TEXT NOT NULL DEFAULT ''
); CREATE INDEX IF NOT EXISTS config_changes_ship ON config_changes(ship, id);`;

export type ConfigChange = { id: number; ts: string; ship: string; key: string; old: string | null; new: string | null; by: string; why: string };

export function recentConfigChanges(ship: string, limit = 8): ConfigChange[] {
  try {
    const d = metricsDb();
    d.exec(LOG);
    return d.query("SELECT * FROM config_changes WHERE ship = ? ORDER BY id DESC LIMIT ?").all(ship, limit) as ConfigChange[];
  } catch {
    return [];
  }
}

/** Serialize a ship YAML document: never fold long values (bin/launch's fallback reader is line-based). */
export function shipYamlText(doc: Document): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/**
 * Change a ship's config. `edit` gets the merged config as a YAML document and
 * changes it as if it were the whole file; what it changed goes into the
 * overlay (comments there survive), is logged, and the merged view is
 * rewritten. Returns the changes made.
 */
export async function editShipConfig(id: string, edit: (doc: Document) => void, who: { by: string; why?: string } = { by: "captain" }): Promise<{ path: string[]; old: unknown; value: unknown }[]> {
  const before = readShipConfig(id);
  if (!before) throw new Error(`No ship ${id}.`);
  const doc = new Document(structuredClone(before));
  edit(doc);
  const after = (doc.toJSON() ?? {}) as Obj;
  const changes = configDiff(before, after);
  if (!changes.length) return [];
  await mkdir(overlayDir(), { recursive: true });
  let ov: Document;
  try {
    ov = parseDocument(await readFile(overlayFile(id), "utf8"));
    if (!isMap(ov.contents)) ov = new Document({});
  } catch {
    ov = new Document({});
    ov.commentBefore = ` ${id}: live ship config (overlay on fleet/ships/${id}.yaml). Written by the shipyard and the helm; edit by hand if needed.\n Maps merge key by key over the base, lists and values replace, null removes a key.`;
  }
  for (const c of changes) {
    // A removed key whose base still has it must become an explicit null; otherwise drop it from the overlay.
    const baseHas = hasPath(readYaml(baseFile(id)), c.path);
    if (c.value === null && !baseHas) {
      ov.deleteIn(c.path);
      // A map left empty in the overlay says nothing: drop it (and any parent it empties).
      for (let i = c.path.length - 1; i > 0; i--) {
        const parent = ov.getIn(c.path.slice(0, i));
        if (isMap(parent) && parent.items.length === 0) ov.deleteIn(c.path.slice(0, i));
        else break;
      }
    } else ov.setIn(c.path, ov.createNode(c.value));
  }
  await writeFile(overlayFile(id), shipYamlText(ov), "utf8");
  try {
    const d = metricsDb();
    d.exec(LOG);
    const ins = d.query("INSERT INTO config_changes (ts, ship, key, old, new, by, why) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const ts = new Date().toISOString();
    for (const c of changes) ins.run(ts, id, c.path.join("."), c.old === undefined ? null : JSON.stringify(c.old), c.value === null ? null : JSON.stringify(c.value), who.by, (who.why ?? "").slice(0, 600));
  } catch (e) {
    console.error("[ship-config] log:", e instanceof Error ? e.message : e);
  }
  materializeShip(id);
  return changes;
}

function hasPath(o: unknown, path: string[]): boolean {
  let cur: unknown = o;
  for (const k of path) {
    if (!isObj(cur) || !(k in cur)) return false;
    cur = cur[k];
  }
  return true;
}
