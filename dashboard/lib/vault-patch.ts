import { readFileSync, writeFileSync } from "node:fs";
import { Document, isMap, parseDocument } from "yaml";
import { aliceVault } from "./paths.ts";
import { resolveNote, splitNote } from "./vault-note.ts";

/**
 * vault_patch (vault plan alice-memory-and-tools, M1): the two edits agents
 * made by hand or with obsidian-axi, done so the note stays valid.
 *
 * - `set`: top-level frontmatter fields. An existing field is replaced where it
 *   stands (its comment and every other byte stay); a new one goes at the end.
 *   The result is parsed again before anything is written.
 * - `check` / `uncheck`: tick or untick the one checklist item whose text
 *   contains the given text. Zero or several matches change nothing.
 *
 * Paths must resolve inside the vault. `career/` and `profile/` are the
 * captain's and are refused.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };
type Value = string | number | boolean | null | unknown[] | Record<string, unknown>;

const CAPTAINS = ["career", "profile"];
const KEY = /^[A-Za-z_][\w-]*$/;
const ITEM = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)\r?$/;

const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** One field set in a frontmatter text: the new text, and what it replaced. */
function setField(fm: string, doc: Document.Parsed, key: string, value: Value): { text: string; before: unknown; existed: boolean; same: boolean } {
  const map = doc.contents;
  if (!isMap(map)) throw new Error("frontmatter is not a mapping");
  const pair = map.items.find((p) => String((p.key as { value?: unknown })?.value) === key);
  // The pair alone, as a one-key document at indent 0, so lists and mappings come out as block YAML.
  const written = new Document({ [key]: value }).toString({ lineWidth: 0 }).trimEnd();
  if (!pair) return { text: `${fm.replace(/\s+$/, "")}\n${written}`, before: undefined, existed: false, same: false };
  const before = doc.get(key);
  if (JSON.stringify(before ?? null) === JSON.stringify(value)) return { text: fm, before, existed: true, same: true };
  const keyRange = (pair.key as { range?: [number, number, number] }).range;
  const valRange = (pair.value as { range?: [number, number, number] } | null)?.range;
  if (!keyRange) throw new Error(`cannot place ${key}`);
  // An empty value (`key:`) has no range worth trusting: replace to the end of the line.
  const lineEnd = fm.indexOf("\n", keyRange[0]) < 0 ? fm.length : fm.indexOf("\n", keyRange[0]);
  let end = pair.value && valRange && valRange[1] > keyRange[1] ? valRange[1] : lineEnd;
  while (end > keyRange[1] && /\s/.test(fm[end - 1]!)) end--; // a block value's range runs through its last newline
  return { text: fm.slice(0, keyRange[0]) + written + fm.slice(end), before, existed: true, same: false };
}

/** Lines of the body that are checklist items outside code fences: where they are and what they say. */
function items(body: string): { at: number; mark: string; text: string }[] {
  const out: { at: number; mark: string; text: string }[] = [];
  let fence = "";
  let offset = 0;
  for (const line of body.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) fence = !fence ? f[1]![0]! : fence === f[1]![0] ? "" : fence;
    const m = !fence && !f ? ITEM.exec(line) : null;
    if (m) out.push({ at: offset + m[1]!.length, mark: m[2]!, text: m[4]! });
    offset += line.length + 1;
  }
  return out;
}

export function vaultPatch(args: { path: string; set?: Record<string, unknown>; check?: string; uncheck?: string }, vault = aliceVault()): Res {
  const set = args.set && typeof args.set === "object" && !Array.isArray(args.set) ? Object.entries(args.set) : [];
  if (!set.length && !args.check && !args.uncheck) return { ok: false, message: "Nothing to do: give set (fields to set), check (an item's text), or uncheck." };
  const r = resolveNote(args.path, vault);
  if (!r.ok) return r;
  if (CAPTAINS.includes(r.rel.split("/")[0]!)) return { ok: false, message: `${r.rel} is the captain's (career/ and profile/ are not edited by agents). Ask the captain.` };

  const original = readFileSync(r.file, "utf8");
  let text = original;
  const done: string[] = [];
  const noop: string[] = [];

  if (set.length) {
    const parts = splitNote(text);
    if (parts.fmText === null) return { ok: false, message: `${r.rel} has no frontmatter to set fields in.` };
    let fm = parts.fmText;
    for (const [key, raw] of set) {
      if (!KEY.test(key)) return { ok: false, message: `"${key}" is not a plain field name (letters, digits, - and _).` };
      const value = raw as Value;
      const doc = parseDocument(fm);
      if (doc.errors.length) return { ok: false, message: `The frontmatter of ${r.rel} does not parse (${doc.errors[0]!.message.split("\n")[0]}). Run vault_doctor, or fix it first.` };
      const next = setField(fm, doc, key, value);
      if (next.same) {
        noop.push(`${key} already ${show(value)}`);
        continue;
      }
      // The new text must parse, hold exactly what was asked, and keep every other field as it was.
      const check = parseDocument(next.text);
      if (check.errors.length || JSON.stringify(check.get(key) ?? null) !== JSON.stringify(value ?? null)) return { ok: false, message: `Could not set ${key} to ${show(value)} without breaking the YAML; nothing was written.` };
      fm = next.text;
      done.push(`${key}: ${next.existed ? show(next.before ?? "") : "(new)"} -> ${show(value)}`);
    }
    const start = original.indexOf("\n") + 1; // the frontmatter text starts after the opening ---
    text = original.slice(0, start) + fm + original.slice(start + parts.fmText.length);
  }

  for (const [verb, needle] of [["check", args.check], ["uncheck", args.uncheck]] as const) {
    if (!needle) continue;
    const bodyStart = splitNote(text).bodyStart;
    const found = items(text.slice(bodyStart)).filter((i) => i.text.toLowerCase().includes(needle.toLowerCase()));
    if (found.length !== 1) {
      const list = found.map((i) => `[${i.mark}] ${i.text.slice(0, 80)}`);
      return { ok: false, message: found.length ? `${found.length} items contain "${needle}": ${list.join("; ")}. Use more of the item's text; nothing was written.` : `No checklist item contains "${needle}" in ${r.rel}; nothing was written.` };
    }
    const item = found[0]!;
    const want = verb === "check" ? "x" : " ";
    if ((item.mark === " ") === (want === " ")) {
      noop.push(`already ${verb === "check" ? "checked" : "unchecked"}: ${item.text.slice(0, 60)}`);
      continue;
    }
    const at = bodyStart + item.at;
    text = text.slice(0, at) + want + text.slice(at + 1);
    done.push(`${verb === "check" ? "checked" : "unchecked"}: ${item.text.slice(0, 60)}`);
  }

  if (text !== original) writeFileSync(r.file, text, "utf8");
  return {
    ok: true,
    message: `${r.rel}: ${done.length ? done.join("; ") : "no change"}${noop.length ? ` (${noop.join("; ")})` : ""}`,
    path: r.rel,
    changed: text !== original,
  };
}
