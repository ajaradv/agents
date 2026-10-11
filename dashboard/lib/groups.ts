import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listChatTargets } from "./chat-targets.ts";
import { listShipAdws, readShips } from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * A rail cluster. Work assigned to the group goes to `lead`, who coordinates
 * the members. Members are registered headless agents only: Firstmate and its
 * live tasks run their own flow and never join a group.
 */
export type Group = {
  id: string;
  name: string;
  lead: string;
  members: string[];
  /** ADW label: a ship plus one of that ship's adws/adw_*.py chains. Display only. */
  adw?: { ship: string; chain: string } | null;
};

const GROUP_ID_RE = /^[a-z][a-z0-9-]{0,40}$/;

export function groupsPath(): string {
  return join(fleetInboxRoot(), "dashboard-groups.json");
}

export async function readGroups(): Promise<Group[]> {
  try {
    const j = JSON.parse(await readFile(groupsPath(), "utf8")) as { groups?: Group[] };
    return Array.isArray(j.groups) ? j.groups : [];
  } catch {
    return [];
  }
}

async function writeGroups(groups: Group[]): Promise<void> {
  await mkdir(fleetInboxRoot(), { recursive: true });
  const tmp = groupsPath() + ".tmp";
  await writeFile(tmp, JSON.stringify({ groups }, null, 2) + "\n", "utf8");
  await rename(tmp, groupsPath());
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "group";
}

/** Ids allowed as group members: registered headless agents. */
export function groupableAgentIds(): string[] {
  return listChatTargets().agents.filter((a) => a.kind === "headless").map((a) => a.id);
}

export type GroupInput = {
  id?: string;
  name?: string;
  lead?: string;
  members?: string[];
  adwShip?: string;
  adwChain?: string;
};

export async function validateGroup(
  input: GroupInput,
  allowed: string[] = groupableAgentIds(),
): Promise<{ group?: Group; error?: string }> {
  const name = String(input.name ?? "").trim();
  if (!name) return { error: "A group needs a name." };
  const id = input.id ? String(input.id) : slugify(name);
  if (!GROUP_ID_RE.test(id)) return { error: "Group id must be lowercase letters, digits, and dashes." };
  const members = [...new Set((input.members ?? []).map((m) => String(m).trim()).filter(Boolean))];
  const lead = String(input.lead ?? "").trim();
  if (members.length === 0) return { error: "Pick at least one member." };
  const bad = members.filter((m) => !allowed.includes(m));
  if (bad.length) {
    return { error: `Not groupable: ${bad.join(", ")}. Members must be registered assistants; Firstmate and its tasks cannot join a group.` };
  }
  if (!lead) return { error: "Pick a lead." };
  if (!members.includes(lead)) return { error: "The lead must be one of the members." };

  let adw: Group["adw"] = null;
  const ship = String(input.adwShip ?? "").trim();
  const chain = String(input.adwChain ?? "").trim();
  if (ship || chain) {
    if (!ship || !chain) return { error: "An ADW label needs both a ship and a chain." };
    const row = (await readShips()).find((s) => s.id === ship);
    if (!row) return { error: `Unknown ship ${ship}.` };
    const chains = row.path ? await listShipAdws(row.path) : [];
    if (!chains.includes(chain)) return { error: `${ship} has no ${chain} (adws/${chain}.py).` };
    adw = { ship, chain };
  }
  return { group: { id, name, lead, members, adw } };
}

export async function saveGroup(input: GroupInput): Promise<{ group?: Group; error?: string }> {
  const r = await validateGroup(input);
  if (!r.group) return r;
  const groups = await readGroups();
  const i = groups.findIndex((g) => g.id === r.group!.id);
  if (i >= 0) groups[i] = r.group;
  else groups.push(r.group);
  await writeGroups(groups);
  return r;
}

export async function deleteGroup(id: string): Promise<boolean> {
  const groups = await readGroups();
  const next = groups.filter((g) => g.id !== id);
  if (next.length === groups.length) return false;
  await writeGroups(next);
  return true;
}

/** Phase names in order from `PhaseParams(name="...")` in an ADW script; loop phases (`test_{i}`) collapse to `test`. */
export function parseAdwPhases(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/PhaseParams\(\s*name\s*=\s*f?["']([^"']+)["']/g)) {
    const name = (m[1] ?? "").replace(/_\{[^}]*\}$/, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export async function readAdwPhases(shipPath: string, chain: string): Promise<string[]> {
  if (!/^adw_[a-z0-9_]+$/.test(chain)) return [];
  try {
    return parseAdwPhases(await readFile(join(shipPath, "adws", `${chain}.py`), "utf8"));
  } catch {
    return [];
  }
}
