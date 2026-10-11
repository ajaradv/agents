import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PLAN_REF = /fleet\/plans\/[\w./-]+\.md/g;
const QUESTION = /^[ \t]*(?:[-*][ \t]*)?Q(\d+)\s*:/gm;
const NEXT_HEADING = /^## /m;

export function planRefsInText(text: string): string[] {
  return [...text.matchAll(PLAN_REF)].map((m) => m[0]);
}

export function resolvePlanRef(ref: string, vault: string): string {
  if (ref.startsWith("/")) return ref;
  return join(vault, ref);
}

export function openQuestionsBody(markdown: string): string {
  const start = markdown.search(/^## Open questions\s*$/m);
  if (start < 0) return markdown;
  const after = markdown.slice(start).replace(/^## Open questions\s*$/m, "");
  const next = after.search(NEXT_HEADING);
  return next < 0 ? after : after.slice(0, next);
}

export function unansweredQuestionNumbers(markdown: string): string[] {
  const body = openQuestionsBody(markdown);
  const nums = [...body.matchAll(QUESTION)].map((m) => m[1] ?? "");
  const unique = [...new Set(nums.filter(Boolean))];
  return unique.filter(
    (n) => !new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?A${n}\\s*:`, "m").test(body),
  );
}

function formatAnswer(label: string, text: string): string {
  const lines = text.trim().split("\n");
  const first = `- ${label}: ${lines[0] ?? ""}`;
  const rest = lines.slice(1).map((line) => `  ${line}`);
  return [first, ...rest].join("\n");
}

function insertIntoOpenQuestions(markdown: string, block: string): string {
  const heading = markdown.match(/^## Open questions\s*$/m);
  if (!heading || heading.index === undefined) {
    const base = markdown.replace(/\s*$/, "");
    return `${base}\n\n## Open questions\n\n${block}\n`;
  }
  const sectionStart = heading.index + heading[0].length;
  const rest = markdown.slice(sectionStart);
  const next = rest.search(NEXT_HEADING);
  const section = next < 0 ? rest : rest.slice(0, next);
  const tail = next < 0 ? "" : rest.slice(next);
  const trimmed = section.replace(/\s*$/, "");
  const inserted = `${trimmed}\n\n${block}\n\n`;
  return markdown.slice(0, sectionStart) + inserted + tail;
}

/** Record the captain's words against every open Qn, or as one A line when none are open. */
export function appendCaptainAnswers(markdown: string, answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) return markdown;
  const missing = unansweredQuestionNumbers(markdown);
  const body = openQuestionsBody(markdown);
  if (missing.length === 0) {
    if (body.includes(trimmed)) return markdown;
    return insertIntoOpenQuestions(markdown, formatAnswer("A", trimmed));
  }
  const blocks = missing.map((n) => formatAnswer(`A${n}`, trimmed));
  return insertIntoOpenQuestions(markdown, blocks.join("\n"));
}

export async function findTaskPlanFile(opts: {
  fmHome: string;
  vault: string;
  taskId: string;
}): Promise<string | null> {
  const names = ["brief.md", "launch-brief.md", "report.md"];
  const refs: string[] = [];
  for (const name of names) {
    try {
      const text = await readFile(join(opts.fmHome, "data", opts.taskId, name), "utf8");
      refs.push(...planRefsInText(text));
    } catch {
      /* missing brief */
    }
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    const path = resolvePlanRef(ref, opts.vault);
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      await readFile(path, "utf8");
      return path;
    } catch {
      /* try the next ref */
    }
  }
  return null;
}
