/**
 * Cheap reads (an experiment; Levels 8 and 9 in the vault research note
 * jev-system-one, after disler/ten-levels-of-jev, MIT): ask a question about a
 * file, or the same question about many files, and get Jev's answer instead of
 * the file. The file never enters the agent's context. For learning something
 * about code (does it validate tokens? which file handles retries?), not for
 * editing it: to change or quote code, the agent still reads it.
 *
 * The extension reads the files (it runs on the host, in the agent's folder);
 * the node asks Jev (agents do not hold the key) and logs each call as use
 * cheap-reads, so the tokens kept out of context can be measured.
 *
 * bin/launch loads this only for agents listed under "cheap-reads" in
 * fleet/home/config/experiments.json.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const base = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
const token = process.env.FLEET_CREW_TOKEN ?? "";
const MAX_FILE = 60_000;
const MAX_FILES = 40;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.venv|__pycache__)\//;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

type Ask = { type: "noul" | "choice" | "score"; question: string; options?: string[] };

function questionOf(a: Ask): Record<string, unknown> {
  const instructions = `${a.question.trim()} Answer about \`file\` (its path is \`path\`).`;
  if (a.type === "choice") {
    const opts = (a.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 30);
    const criteria: Record<string, string | null> = Object.fromEntries(opts.map((o) => [o, null]));
    if (!Object.keys(criteria).some((k) => /^(other|none)/i.test(k))) criteria.other = "None of these";
    return { type: "choice", instructions, criteria };
  }
  if (a.type === "score") return { type: "score", instructions, criteria: (a.options?.length ?? 0) >= 2 ? a.options!.slice(0, 10) : ["Not at all", "Somewhat", "Fully"] };
  return { type: "noul", instructions };
}

function readOne(cwd: string, p: string): { path: string; content: string } | { path: string; error: string } {
  const abs = path.resolve(cwd, p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { path: p, error: "not a file" };
    if (st.size > MAX_FILE) return { path: p, error: `over ${MAX_FILE / 1000} KB; read the part you need instead` };
    return { path: path.relative(cwd, abs) || p, content: readFileSync(abs, "utf8") };
  } catch (e) {
    return { path: p, error: e instanceof Error ? e.message : String(e) };
  }
}

function expand(cwd: string, patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pat of patterns) {
    if (!/[*?[{]/.test(pat)) {
      out.add(pat);
      continue;
    }
    for (const f of new Glob(pat).scanSync({ cwd, onlyFiles: true })) if (!SKIP.test(`/${f}`)) out.add(f);
  }
  return [...out];
}

async function askNode(question: Record<string, unknown>, files: { path: string; content: string }[]): Promise<{ results?: { path: string; answer: string; p: number | null; error?: string }[]; error?: string }> {
  if (!base || !token) return { error: "this session cannot reach the fleet node" };
  try {
    const res = await fetch(`${base}/api/jev/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": token },
      body: JSON.stringify({ question, files }),
      signal: AbortSignal.timeout(30_000),
    });
    return (await res.json()) as { results?: { path: string; answer: string; p: number | null }[]; error?: string };
  } catch (e) {
    return { error: `the fleet node did not answer (${e instanceof Error ? e.message : String(e)})` };
  }
}

function render(results: { path: string; answer: string; p: number | null; error?: string }[], failed: { path: string; error: string }[]): string {
  const rows = results.map((r) => `  ${r.path},${r.error ? `error: ${r.error}` : r.answer},${r.p === null ? "-" : r.p.toFixed(2)}`);
  const bad = failed.map((f) => `  ${f.path},not read: ${f.error},-`);
  const all = [...rows, ...bad];
  return all.length ? `answers[${all.length}]{path,answer,p}:\n${all.join("\n")}\n(The files were not loaded into your context. Read a file when you need to edit or quote it.)` : "answers: 0 files matched";
}

export default function (pi: ExtensionAPI) {
	const Params = {
		type: StringEnum(["noul", "choice", "score"] as const),
		question: Type.String({ description: "One snap judgment, e.g. 'Does this file validate auth tokens?'" }),
		options: Type.Optional(Type.Array(Type.String(), { description: "choice: the options; score: levels low to high" })),
	};

	pi.registerTool({
		name: "ask_file",
		label: "Ask about a file",
		description:
			"Learn something about one file without reading it into your context: a yes/no (noul), one of your options (choice), or a position on your scale (score), with a probability. For questions, not edits: read the file when you need to change or quote it. Files up to 60 KB.",
		parameters: Type.Object({ path: Type.String(), ...Params }),
		async execute(_id, p, _signal, _update, ctx) {
			const f = readOne(ctx?.cwd ?? process.cwd(), p.path);
			if ("error" in f) return text(`error: ${f.path}: ${f.error}`);
			const r = await askNode(questionOf(p), [f]);
			return text(r.error ? `error: ${r.error}` : render(r.results ?? [], []));
		},
	});

	pi.registerTool({
		name: "ask_files",
		label: "Ask about many files",
		description:
			"The same question about many files at once (paths or globs like src/**/*.ts; node_modules and build folders skipped; up to 40 files), answered in parallel without loading them. Use it to find which files matter before opening any.",
		parameters: Type.Object({ paths: Type.Array(Type.String(), { description: "Paths or globs" }), ...Params }),
		async execute(_id, p, _signal, _update, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const names = expand(cwd, p.paths);
			const more = names.length > MAX_FILES ? names.length - MAX_FILES : 0;
			const read = names.slice(0, MAX_FILES).map((n) => readOne(cwd, n));
			const ok = read.filter((f): f is { path: string; content: string } => "content" in f);
			const failed = read.filter((f): f is { path: string; error: string } => "error" in f);
			const r = ok.length ? await askNode(questionOf(p), ok) : { results: [] };
			if (r.error) return text(`error: ${r.error}`);
			return text(`${render(r.results ?? [], failed)}${more ? `\n${more} more files matched; narrow the glob to ask about them.` : ""}`);
		},
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nCheap reads (experiment): to learn something about files without loading them (does this file do X, which of these files handles Y), use ask_file or ask_files; they answer from Jev and keep the files out of your context. Read a file when you need to edit or quote it.`,
	}));
}
