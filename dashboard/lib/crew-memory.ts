import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Tiered crew memory. A crewmate's session used to run on across voyages, so
 * old work leaked into new voyages (a designer tried to redo a task from the
 * previous, docked voyage). Memory now has tiers, and bin/launch puts them in
 * the crewmate's prompt from most stable to most transient, so the stable part
 * stays a cached prefix and only the bottom changes between voyages:
 *
 * 1. Project memory (fleet/inbox/ships/<ship>/memory/project.md): shared by
 *    the ship's crew, kept across voyages: conventions, commands, gotchas.
 * 2. Each crewmate's notes (fleet/inbox/<id>/memory/notes.md): kept.
 * 3. This voyage (fleet/inbox/ships/<ship>/memory/voyage.md): the voyage's
 *    goal and branch and a scratchpad the crew shares; at dock it is archived
 *    into the vault voyage note and deleted. Each crewmate's plan.md and
 *    state.md (compaction handoff) are voyage-scoped too and cleared.
 *
 * At Set sail every crewmate also starts a fresh session (empty history), so
 * nothing from the previous voyage rides along in the conversation.
 */

export const shipMemoryDir = (ship: string) => join(fleetInboxRoot(), "ships", ship, "memory");
const crewMemoryDir = (agent: string) => join(fleetInboxRoot(), agent, "memory");

const PROJECT_HEADER = (ship: string) =>
  `# ${ship}: project memory\n\nShared by the crew and kept across voyages. Lasting knowledge only: conventions, commands, gotchas, decisions the next voyage needs. Keep it short; prune what is no longer true.\n\n`;

/** Fresh session ids for crewmates (bin/launch reads fleet/inbox/<id>/sessions/current). */
export async function freshSession(agent: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").toLowerCase();
  const dir = join(fleetInboxRoot(), agent, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "current"), `dashboard-${agent}-${stamp}\n`, "utf8");
}

/** Voyage-scoped files in a crewmate's own memory folder. */
async function clearTransient(agent: string): Promise<void> {
  for (const f of ["plan.md", "state.md"]) await rm(join(crewMemoryDir(agent), f), { force: true });
}

export async function startVoyageMemory(ship: string, v: { goal: string; branch?: string; worktree?: string; record: string }, crew: string[]): Promise<void> {
  const dir = shipMemoryDir(ship);
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, "project.md"))) await writeFile(join(dir, "project.md"), PROJECT_HEADER(ship), "utf8");
  await writeFile(
    join(dir, "voyage.md"),
    [
      `# Voyage: ${v.goal}`,
      "",
      `- Started: ${new Date().toISOString()}`,
      ...(v.branch ? [`- Branch: ${v.branch}`] : []),
      `- Record (vault): ${v.record}`,
      "",
      "## Scratchpad",
      "",
      "Progress, decisions, and open questions for this voyage, shared by the crew. Archived into the voyage record and cleared at dock.",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const agent of crew) {
    await clearTransient(agent);
    await freshSession(agent);
  }
}

/**
 * Crew memory as files relative to the inbox, for a ship host that keeps its
 * own (lib/ship-host.ts putMemory): the ship's and the crewmates' memory notes
 * and current session ids.
 */
export async function memoryFiles(ship: string, crew: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const add = async (rel: string) => {
    try {
      out[rel] = await readFile(join(fleetInboxRoot(), rel), "utf8");
    } catch {
      /* none */
    }
  };
  for (const dir of [`ships/${ship}/memory`, ...crew.map((a) => `${a}/memory`)]) {
    for (const n of await readdir(join(fleetInboxRoot(), dir)).catch(() => [] as string[])) if (n.endsWith(".md")) await add(`${dir}/${n}`);
  }
  for (const a of crew) await add(`${a}/sessions/current`);
  return out;
}

/** Bring back memory a remote host kept (its notes only; sessions stay where they ran). */
export async function writeMemoryFiles(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    if (!/^(ships\/)?[a-z][\w-]*\/memory\/[a-z][\w-]*\.md$/.test(rel)) continue;
    await mkdir(dirname(join(fleetInboxRoot(), rel)), { recursive: true });
    await writeFile(join(fleetInboxRoot(), rel), text, "utf8");
  }
}

/** The voyage-scoped memory files a remote host should drop at dock (empty text removes). */
export function voyageMemoryCleared(ship: string, crew: string[]): Record<string, string> {
  return Object.fromEntries([`ships/${ship}/memory/voyage.md`, ...crew.flatMap((a) => [`${a}/memory/plan.md`, `${a}/memory/state.md`])].map((rel) => [rel, ""]));
}

/** At dock: the voyage scratchpad's text (for the vault note), then the voyage-scoped memory is gone. */
export async function endVoyageMemory(ship: string, crew: string[]): Promise<string> {
  const file = join(shipMemoryDir(ship), "voyage.md");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    /* none */
  }
  await rm(file, { force: true });
  for (const agent of crew) await clearTransient(agent);
  const scratch = text.split(/^## Scratchpad\s*$/m)[1]?.replace(/^\s*Progress, decisions, and open questions[^\n]*\n/, "").trim() ?? "";
  return scratch;
}
