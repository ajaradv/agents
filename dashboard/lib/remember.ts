import { readFileSync, writeFileSync } from "node:fs";
import { observationExists, promoteObservation } from "./facts.ts";
import { aliceVault } from "./paths.ts";
import { resolveNote } from "./vault-note.ts";

/**
 * remember (vault plan alice-memory-and-tools, M2): add or replace one bullet
 * in a section of the captain's profile, fleet/captain.md. Understanding
 * (standing preferences and instructions) lives there, small and curated;
 * exact changing values go to facts (lib/facts.ts). The rest of the file stays
 * byte for byte, the file stays under 4 KB, and the path goes through the same
 * vault guard as vault_patch (inside the vault, symlinks resolved).
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

export const PROFILE = "fleet/captain.md";
export const MAX_PROFILE_BYTES = 4096;
export const MAX_LINE = 300;

export type RememberArgs = { section: string; line: string; replaces?: string; create?: boolean; observation?: number };

const HEADING = /^##\s+(.+?)\s*$/;
const ANY_HEADING = /^#{1,2}\s/;
const bytes = (s: string) => Buffer.byteLength(s);
// Messages end in their own period, so a line's final period is dropped here.
const show = (s: string) => (s.length > 70 ? `${s.slice(0, 69)}…` : s.replace(/\.$/, ""));

export function remember(a: RememberArgs, vault = aliceVault()): Res {
  const r = resolveNote(PROFILE, vault);
  if (!r.ok) return { ok: false, message: r.message };
  const line = String(a.line ?? "").trim().replace(/^[-*]\s+/, "");
  if (!line) return { ok: false, message: "Give the line to remember." };
  if (/[\r\n]/.test(line)) return { ok: false, message: "A remembered line is one line: no line breaks." };
  if (line.length > MAX_LINE) return { ok: false, message: `The line is ${line.length} characters; the limit is ${MAX_LINE}. Shorten it.` };
  const want = String(a.section ?? "").trim().replace(/^#+\s*/, "");
  if (!want) return { ok: false, message: "Give the section (an existing ## heading in the profile)." };
  if (a.observation !== undefined && !observationExists(a.observation)) return { ok: false, message: `No observation ${a.observation}; nothing was written.` };

  const original = readFileSync(r.file, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(eol);
  const headings = lines.flatMap((l, i) => {
    const m = HEADING.exec(l);
    return m ? [{ i, name: m[1]! }] : [];
  });
  const found = headings.find((h) => h.name.toLowerCase() === want.toLowerCase());
  const bullet = `- ${line}`;
  let next = lines;
  let what: string;

  if (!found) {
    if (!a.create) return { ok: false, message: `No section "${want}" in ${PROFILE}. Sections: ${headings.map((h) => h.name).join("; ") || "none"}. Pass create=true to add it.` };
    const body = [...lines];
    while (body.length && body[body.length - 1] === "") body.pop();
    next = [...body, "", `## ${want}`, "", bullet, ""];
    what = `added section "${want}" with: ${show(line)}`;
  } else {
    // The section runs to the next heading of level 1 or 2.
    let end = lines.length;
    for (let k = found.i + 1; k < lines.length; k++) {
      if (ANY_HEADING.test(lines[k]!)) {
        end = k;
        break;
      }
    }
    const inSection = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i > found.i && i < end && l.startsWith("- "));
    if (a.replaces !== undefined && a.replaces.trim()) {
      const needle = a.replaces.trim().toLowerCase();
      const hits = inSection.filter(({ l }) => l.toLowerCase().includes(needle));
      if (hits.length !== 1) {
        const pool = hits.length ? hits : inSection;
        return { ok: false, message: `${hits.length ? `${hits.length} bullets` : "No bullet"} in "${found.name}" contain "${a.replaces}". ${hits.length ? "Candidates" : "Bullets there"}: ${pool.map(({ l }) => `"${show(l.slice(2))}"`).join("; ") || "none"}. Use more of the bullet's text; nothing was written.` };
      }
      const hit = hits[0]!;
      if (hit.l === bullet) what = `already there: ${show(line)}`;
      else {
        next = [...lines];
        next[hit.i] = bullet;
        what = `replaced "${show(hit.l.slice(2))}" with "${show(line)}" in "${found.name}"`;
      }
    } else if (inSection.some(({ l }) => l === bullet)) {
      what = `already there: ${show(line)}`;
    } else {
      // After the section's last non-blank line (or right after the heading when it is empty).
      let at = end;
      while (at > found.i + 1 && lines[at - 1] === "") at--;
      next = [...lines];
      if (at === found.i + 1) next.splice(at, 0, "", bullet);
      else next.splice(at, 0, bullet);
      what = `added to "${found.name}": ${show(line)}`;
    }
  }

  const text = next.join(eol);
  if (text === original) {
    if (a.observation !== undefined) promoteObservation(a.observation, "captain.md");
    return { ok: true, message: `${PROFILE}: ${what} (no change).`, changed: false };
  }
  if (bytes(text) > MAX_PROFILE_BYTES && bytes(text) > bytes(original)) {
    return { ok: false, message: `${PROFILE} would be ${bytes(text)} bytes; the limit is ${MAX_PROFILE_BYTES}. Tighten an existing line (replaces=<its text>) instead; nothing was written.` };
  }
  writeFileSync(r.file, text, "utf8");
  if (a.observation !== undefined) promoteObservation(a.observation, "captain.md");
  return { ok: true, message: `${PROFILE}: ${what}${a.observation !== undefined ? `. Observation ${a.observation} promoted` : ""}.`, changed: true, bytes: bytes(text) };
}
