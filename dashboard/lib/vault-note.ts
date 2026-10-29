import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse as yamlParse } from "yaml";
import { aliceVault } from "./paths.ts";

/**
 * vault_note (vault plan alice-memory-and-tools, M1): one note as an agent
 * should read it: frontmatter, summary, the headings with their sizes, and the
 * text of a single section on request, never the whole file unless asked.
 * Also the shared note parsing (frontmatter split, heading sections) and the
 * vault path guard that vault_patch and the vault mirror use.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

/** The most of a section or note body one call returns. */
export const NOTE_CAP = 12_000;

/** A note split into its frontmatter and body; `fm` is null when absent or not valid YAML (`fmError` says which). */
export function splitNote(text: string): { fmText: string | null; fm: Record<string, unknown> | null; fmError: string; body: string; bodyStart: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fmText: null, fm: null, fmError: "", body: text, bodyStart: 0 };
  const rest = { fmText: m[1]!, body: text.slice(m[0].length), bodyStart: m[0].length };
  try {
    const y = yamlParse(m[1]!);
    return { ...rest, fm: y && typeof y === "object" && !Array.isArray(y) ? (y as Record<string, unknown>) : {}, fmError: "" };
  } catch (e) {
    return { ...rest, fm: null, fmError: e instanceof Error ? e.message.split("\n")[0]! : "invalid YAML" };
  }
}

export type Section = {
  level: number;
  heading: string;
  /** Offsets in the body: the heading line starts at `start`; `flatEnd` is the next heading of any level, `treeEnd` the next of the same or a higher level (subsections included). */
  start: number;
  flatEnd: number;
  treeEnd: number;
};

/** The headings of a markdown body (code fences skipped), in order. */
export function sectionsOf(body: string): Section[] {
  const found: Omit<Section, "flatEnd" | "treeEnd">[] = [];
  let fence = "";
  let offset = 0;
  for (const line of body.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) fence = !fence ? f[1]![0]! : fence === f[1]![0] ? "" : fence;
    const h = !fence && !f ? /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line.replace(/\r$/, "")) : null;
    if (h) found.push({ level: h[1]!.length, heading: h[2]!, start: offset });
    offset += line.length + 1;
  }
  return found.map((s, i) => ({
    ...s,
    flatEnd: found[i + 1]?.start ?? body.length,
    treeEnd: found.slice(i + 1).find((n) => n.level <= s.level)?.start ?? body.length,
  }));
}

const bytes = (s: string) => Buffer.byteLength(s);

/**
 * A note path as the agent gave it (vault-relative, or absolute inside the
 * vault, `.md` optional) -> the vault-relative path and the real file. Refuses
 * anything that leaves the vault, through `..` or a symlink.
 */
export function resolveNote(path: string, vault = aliceVault()): { ok: true; rel: string; file: string } | { ok: false; message: string } {
  let p = path.trim().replace(/^\.\//, "");
  if (!p) return { ok: false, message: "Give a note path, e.g. tasks/fleet-memory-m1-tools.md." };
  if (isAbsolute(p)) p = relative(vault, p);
  if (!p.endsWith(".md")) p += ".md";
  if (p.split(/[\\/]/).includes("..") || isAbsolute(p)) return { ok: false, message: `${path} is outside the vault.` };
  const file = join(vault, p);
  if (!existsSync(file)) return { ok: false, message: `No note ${p} in the vault. vault_search finds notes by words or frontmatter.` };
  let real: string;
  let root: string;
  try {
    real = realpathSync(file);
    root = realpathSync(vault);
  } catch {
    return { ok: false, message: `Cannot read ${p}.` };
  }
  if (real !== root && !real.startsWith(root + sep)) return { ok: false, message: `${p} resolves outside the vault.` };
  if (!statSync(real).isFile()) return { ok: false, message: `${p} is not a note.` };
  return { ok: true, rel: p.split(sep).join("/"), file: real };
}

/** Frontmatter as a short flat map: lists joined, long values cut, summary and description left to their own lines. */
function compactFm(fm: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (k === "summary" || k === "description" || v === null || v === undefined || v === "") continue;
    const s = Array.isArray(v) ? v.flat(3).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (!s) continue;
    out[k] = s.length > 120 ? `${s.slice(0, 119)}…` : s;
  }
  return out;
}

const norm = (h: string) => h.replace(/^#+\s*/, "").trim().toLowerCase();

/** Cut text to NOTE_CAP bytes (at a line end when it can), saying how much was left out. */
function cap(text: string): { text: string; cut: boolean } {
  if (bytes(text) <= NOTE_CAP) return { text, cut: false };
  const head = Buffer.from(text).subarray(0, NOTE_CAP).toString("utf8").replace(/�$/, "");
  const nl = head.lastIndexOf("\n");
  return { text: (nl > NOTE_CAP / 2 ? head.slice(0, nl) : head).trimEnd(), cut: true };
}

export function vaultNote(path: string, opts: { section?: string; full?: boolean } = {}, vault = aliceVault()): Res {
  const r = resolveNote(path, vault);
  if (!r.ok) return { ok: false, message: r.message };
  const text = readFileSync(r.file, "utf8");
  const { fm, fmError, body } = splitNote(text);
  const sections = sectionsOf(body);
  const head: Res = {
    ok: true,
    message: `${r.rel} (${bytes(text)} bytes, ${sections.length} section${sections.length === 1 ? "" : "s"})`,
    path: r.rel,
    ...(fmError ? { frontmatter_error: `frontmatter does not parse (${fmError}); vault_doctor lists the fixable ones` } : {}),
    ...(fm ? { frontmatter: compactFm(fm) } : {}),
    ...(fm && (fm.summary || fm.description) ? { summary: String(fm.summary || fm.description) } : {}),
  };
  const list = sections.map((s) => ({ heading: `${"#".repeat(s.level)} ${s.heading}`, bytes: bytes(body.slice(s.start, s.treeEnd)) }));

  if (opts.section) {
    const want = norm(opts.section);
    const exact = sections.filter((s) => norm(s.heading) === want);
    const hits = exact.length ? exact : sections.filter((s) => norm(s.heading).includes(want));
    if (hits.length !== 1) {
      const names = (hits.length ? hits : sections).map((s) => s.heading);
      return { ok: false, message: hits.length ? `Section "${opts.section}" matches ${hits.length} headings: ${names.join("; ")}. Give more of the heading.` : `No section "${opts.section}" in ${r.rel}. Headings: ${names.join("; ") || "none"}.` };
    }
    const s = hits[0]!;
    const c = cap(body.slice(s.start, s.treeEnd).trimEnd());
    // Just the section: the caller has the frontmatter and the headings from the first look.
    return { ok: true, message: `${r.rel} § ${s.heading} (${bytes(body.slice(s.start, s.treeEnd))} bytes)`, path: r.rel, section: s.heading, content: c.text, ...(c.cut ? { cut: `Section cut at ${NOTE_CAP} bytes of ${bytes(body.slice(s.start, s.treeEnd))}; ask for a subsection or read the file for the rest.` } : {}) };
  }
  if (opts.full) {
    const c = cap(body.trim());
    return { ...head, body: c.text, ...(c.cut ? { cut: `Body cut at ${NOTE_CAP} bytes of ${bytes(body)}; ask for sections one at a time.` } : {}) };
  }
  return { ...head, headings: list };
}
