import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as yamlParse } from "yaml";
import { escapeHtml } from "./quota.ts";
import { aliceVault, nodeStateDir } from "./paths.ts";
import { linkName } from "./vault-tasks.ts";

/**
 * Vault doctor (vault task fleet-vault-doctor): deterministic checks of the
 * captain's vault, a report by default, and fixes only for problems with one
 * safe mechanical answer. Run by bin/vault-doctor, and by the node on a
 * schedule for the Health page.
 *
 * Checks: frontmatter parses; a Task's status and priority are allowed values;
 * every [[link]] and blocked_by entry names a file that exists; tasks/index.md
 * lists every task that is not done. Templates (Templater placeholders) and
 * dot folders are left out.
 */

export type Problem = {
  note: string;
  check: "frontmatter" | "task-fields" | "link" | "task-index";
  detail: string;
  /** Set when --fix can repair it. */
  fixable?: boolean;
};

export type Examination = { notes: number; links: number; problems: Problem[] };

const TASK_STATUS = ["open", "in-progress", "blocked", "done"];
const TASK_PRIORITY = ["low", "medium", "high"];
const SKIP_DIRS = new Set(["templates"]);

type Note = { path: string; rel: string; text: string; fm: string | null };

function walk(root: string): { notes: Note[]; names: Set<string> } {
  const notes: Note[] = [];
  const names = new Set<string>();
  const visit = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        visit(p);
        continue;
      }
      names.add(e);
      names.add(e.replace(/\.md$/, ""));
      const rel = relative(root, p);
      if (!e.endsWith(".md") || SKIP_DIRS.has(rel.split("/")[0]!)) continue;
      const text = readFileSync(p, "utf8");
      const m = /^---\n([\s\S]*?)\n---/.exec(text);
      notes.push({ path: p, rel, text, fm: m ? m[1]! : null });
    }
  };
  visit(root);
  return { notes, names };
}

/** Quote top-level values that contain ": " or " #" (YAML reads those as structure); null when that changes nothing. */
export function quoteColonValues(fm: string): string | null {
  const out = fm
    .split("\n")
    .map((line) => {
      const k = /^([A-Za-z_][\w-]*): (.*)$/.exec(line);
      if (!k) return line;
      const v = k[2]!;
      if (!v || /^["'[{|>&*!]/.test(v) || !/: | #/.test(v)) return line;
      return `${k[1]}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  return out === fm ? null : out;
}

function parses(fm: string): Record<string, unknown> | null {
  try {
    const y = yamlParse(fm);
    return y && typeof y === "object" && !Array.isArray(y) ? (y as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** Links in a note's text, outside code: the names they point at. */
function linksIn(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...plain.matchAll(/!?\[\[([^\]|#^]+)(?:[#^|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim()).filter(Boolean);
}

export function examineVault(root: string): Examination {
  const { notes, names } = walk(root);
  const problems: Problem[] = [];
  let links = 0;
  const openTasks: string[] = [];
  for (const n of notes) {
    let fm: Record<string, unknown> | null = {};
    if (n.fm !== null) {
      fm = parses(n.fm);
      if (!fm) {
        const fixed = quoteColonValues(n.fm);
        problems.push({ note: n.rel, check: "frontmatter", detail: "frontmatter is not valid YAML (tools skip this note)", ...(fixed && parses(fixed) ? { fixable: true } : {}) });
      }
    }
    if (fm && String(fm.type ?? "") === "Task") {
      const status = String(fm.status ?? "");
      const priority = String(fm.priority ?? "");
      if (!TASK_STATUS.includes(status)) problems.push({ note: n.rel, check: "task-fields", detail: `status "${status}" is not one of ${TASK_STATUS.join(", ")}` });
      if (!TASK_PRIORITY.includes(priority)) problems.push({ note: n.rel, check: "task-fields", detail: `priority "${priority}" is not one of ${TASK_PRIORITY.join(", ")}` });
      if (!String(fm.title ?? "").trim()) problems.push({ note: n.rel, check: "task-fields", detail: "no title" });
      if (n.rel.startsWith("tasks/") && status !== "done") openTasks.push(basename(n.rel, ".md"));
      const blocked = Array.isArray(fm.blocked_by) ? fm.blocked_by.flat(3) : fm.blocked_by ? [fm.blocked_by] : [];
      for (const b of blocked) {
        const name = linkName(b);
        if (name && !names.has(name)) problems.push({ note: n.rel, check: "link", detail: `blocked_by names ${name}, which does not exist` });
      }
    }
    for (const target of linksIn(n.text)) {
      links++;
      const name = basename(target).replace(/\.md$/, "");
      if (!names.has(name) && !names.has(basename(target))) problems.push({ note: n.rel, check: "link", detail: `[[${target}]] points at nothing` });
    }
  }
  const index = notes.find((n) => n.rel === "tasks/index.md");
  if (index) {
    const listed = new Set(linksIn(index.text).map((t) => basename(t).replace(/\.md$/, "")));
    for (const id of openTasks) if (!listed.has(id)) problems.push({ note: "tasks/index.md", check: "task-index", detail: `does not list ${id}, which is not done` });
  }
  return { notes: notes.length, links, problems };
}

/** Apply the safe fixes (quoting values in frontmatter that does not parse). Returns the notes changed. */
export function fixVault(root: string): string[] {
  const changed: string[] = [];
  for (const n of walk(root).notes) {
    if (n.fm === null || parses(n.fm)) continue;
    const fixed = quoteColonValues(n.fm);
    if (!fixed || !parses(fixed)) continue;
    writeFileSync(n.path, n.text.replace(n.fm, fixed), "utf8");
    changed.push(n.rel);
  }
  return changed;
}

/** The doctor's report as the vault_doctor tool shows it; `fix` does only what bin/vault-doctor --fix does. */
export function doctorReport(fix = false, vault = aliceVault()): { ok: boolean; message: string; [k: string]: unknown } {
  try {
    const fixed = fix ? fixVault(vault) : [];
    const r = examineVault(vault);
    return {
      ok: true,
      message: `${r.problems.length} problem(s) in ${r.notes} notes (${r.links} links checked)${fix ? `; fixed ${fixed.length} note(s)` : ""}`,
      ...(fixed.length ? { fixed } : {}),
      problems: r.problems.map((p) => ({ check: p.check, note: p.note, detail: p.detail, fixable: Boolean(p.fixable) })),
    };
  } catch (e) {
    return { ok: false, message: `Could not read the vault: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A problem's identity, for telling new problems from known ones. */
export const problemKey = (p: Problem) => `${p.check}\u0000${p.note}\u0000${p.detail}`;

// ---------------------------------------------------------------- scheduled run (node) and Health card (dashboard)

type DoctorState = { ts: string; vault: string; notes: number; links: number; problems: Problem[]; error?: string };

const stateFile = () => join(nodeStateDir(), "vault-doctor.json");

function readState(): DoctorState | null {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as DoctorState;
  } catch {
    return null;
  }
}

/** Run the checks (no fixes), save the result for the Health card, and return the problems not seen last time. */
export function scheduledVaultCheck(vault = aliceVault()): { result: DoctorState; fresh: Problem[] } {
  const before = new Set((readState()?.problems ?? []).map(problemKey));
  let result: DoctorState;
  try {
    result = { ts: new Date().toISOString(), vault, ...examineVault(vault) };
  } catch (e) {
    result = { ts: new Date().toISOString(), vault, notes: 0, links: 0, problems: [], error: e instanceof Error ? e.message : String(e) };
  }
  mkdirSync(nodeStateDir(), { recursive: true });
  writeFileSync(stateFile(), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { result, fresh: result.problems.filter((p) => !before.has(problemKey(p))) };
}

/** Health: the last scheduled check, folded when the vault is clean. */
export function vaultDoctorHtml(): string {
  const s = readState();
  if (!s) return `<details class="fold"><summary>Vault · not checked yet</summary><p class="muted">The node checks the vault a few minutes after it starts, then every 6 hours. Run <code>bin/vault-doctor</code> to check now.</p></details>`;
  const when = new Date(s.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (s.error) return `<details class="fold" open><summary>Vault · check failed</summary><p class="warn">${escapeHtml(s.error)}</p></details>`;
  if (!s.problems.length) return `<details class="fold"><summary>Vault · no problems</summary><p class="muted">${s.notes} notes and ${s.links} links checked ${escapeHtml(when)}.</p></details>`;
  const rows = s.problems
    .slice(0, 20)
    .map((p) => `<tr><td>${escapeHtml(p.check)}</td><td><code>${escapeHtml(p.note)}</code></td><td>${escapeHtml(p.detail)}${p.fixable ? ` <span class="muted">(fixable)</span>` : ""}</td></tr>`)
    .join("");
  const fixable = s.problems.filter((p) => p.fixable).length;
  return `<details class="fold" open><summary>Vault · ${s.problems.length} problem${s.problems.length > 1 ? "s" : ""}</summary><table class="spend-table"><thead><tr><th>Check</th><th>Note</th><th>Problem</th></tr></thead><tbody>${rows}</tbody></table><p class="muted">${s.notes} notes and ${s.links} links checked ${escapeHtml(when)}.${fixable ? ` <code>bin/vault-doctor --fix</code> repairs the ${fixable} marked fixable.` : ""}${fixable < s.problems.length ? " Alice can fix the rest with you." : ""}</p></details>`;
}
