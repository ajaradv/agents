import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { TIER2_TOOLS } from "./go-gate.ts";
import { aliceVault } from "./paths.ts";

/**
 * Fleet orders (Alice omni plan, phase 2): one vault note per order at
 * <vault>/fleet/orders/<yyyy-mm-dd>-<slug>.md. The note is the order and
 * carries its status; Alice executes its steps exactly as written.
 *
 *   ## Steps
 *   1. `ship_tasks` ship=kinwork
 *      expect: the open voyage and its tasks
 *   2. `fleet_chat` to=kinwork-lead text="Status for the captain, please."
 *      expect: the message lands in kinwork-lead's thread
 *
 *   ## Acceptance
 *   - `agent_chat_read` agent=kinwork-lead n=5
 *     expect: the message above is in the thread
 *
 * Each step is one fleet tool call with literal arguments plus an expect line.
 * Acceptance lines are read tools, run after the steps and numbered after
 * them. Anything else is rejected with its line number, so planners learn the
 * contract when they submit (bin/order check).
 */

export const ORDER_STATUSES = ["queued", "approved", "running", "needs-captain", "done", "failed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Tools an order step may name, with their parameters: reads, fleet_chat, and the tier 2 fleet actions (the order's Go covers them). */
export const ORDER_TOOLS: Record<string, { params: string[]; required: string[]; read: boolean }> = {
  ...Object.fromEntries(Object.entries(TIER2_TOOLS).map(([k, v]) => [k, { ...v, read: false }])),
  fleet_status: { params: ["detail"], required: [], read: true },
  ship_log: { params: ["ship", "limit", "kind"], required: ["ship"], read: true },
  ship_tasks: { params: ["ship"], required: ["ship"], read: true },
  ship_maneuvers: { params: ["ship"], required: ["ship"], read: true },
  agent_chat_read: { params: ["agent", "n"], required: ["agent"], read: true },
  recall: { params: ["query", "limit"], required: ["query"], read: true },
  vault_tasks: { params: ["filter", "id"], required: [], read: true },
  ship_next: { params: ["ship", "full"], required: [], read: true },
  // M1/M2 reads (extensions/fleet.ts). vault_doctor takes no fix here: a repair is a write.
  fleet_query: { params: ["query", "days", "since", "until", "by", "limit", "full"], required: ["query"], read: true },
  vault_note: { params: ["path", "section", "full"], required: ["path"], read: true },
  vault_search: { params: ["query", "type", "status", "ship", "path", "limit", "full"], required: [], read: true },
  vault_doctor: { params: ["full"], required: [], read: true },
  fact_get: { params: ["subject", "key", "history", "observations", "limit", "full"], required: [], read: true },
  fleet_chat: { params: ["to", "text"], required: ["to", "text"], read: false },
};

export type OrderStep = {
  /** 1-based; acceptance lines continue after the steps. */
  n: number;
  phase: "step" | "acceptance";
  tool: string;
  args: Record<string, string>;
  expect: string;
  line: number;
};

export type OrderMeta = {
  title: string;
  order: string;
  status: OrderStatus;
  ship: string;
  submitted_by: string;
  created: string;
  approved?: string;
  started?: string;
  ended?: string;
  /** Why it stopped (needs-captain, failed). */
  reason?: string;
  /** Retry resumes at this step. */
  resume?: number;
};

export type Order = { meta: OrderMeta; intent: string; steps: OrderStep[]; body: string; file: string };
export type ParseResult = { order: Order | null; errors: string[]; meta: OrderMeta | null };

const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,63}$/;
const META_KEYS: (keyof OrderMeta)[] = ["title", "order", "status", "ship", "submitted_by", "created", "approved", "started", "ended", "reason", "resume"];

export function ordersDir(): string {
  return join(aliceVault(), "fleet", "orders");
}

export function orderFile(slug: string): string | null {
  return SLUG_RE.test(slug) ? join(ordersDir(), `${slug}.md`) : null;
}

/** Collapse whitespace so `text="a  b"` and `text="a b"` match. */
export function normalizeArg(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/** `key=value key2="quoted value"` → map; null on a malformed pair. */
export function parseArgs(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let rest = s.trim();
  while (rest) {
    const m = rest.match(/^([a-z_]+)=("((?:[^"\\]|\\.)*)"|[^\s"]+)\s*/);
    if (!m) return null;
    out[m[1]!] = m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : m[2]!;
    rest = rest.slice(m[0].length);
  }
  return out;
}

function section(body: string, name: string): { text: string; offset: number } | null {
  const re = new RegExp(`^## ${name}\\s*$`, "m");
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = body.slice(start).search(/^## /m);
  return { text: next < 0 ? body.slice(start) : body.slice(start, start + next), offset: body.slice(0, start).split("\n").length };
}

function parseLines(sec: { text: string; offset: number }, phase: OrderStep["phase"], first: number, errors: string[]): OrderStep[] {
  const steps: OrderStep[] = [];
  const lines = sec.text.split("\n");
  const ITEM = phase === "step" ? /^(\d+)\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = sec.offset + i;
    if (!raw.trim()) continue;
    const m = raw.match(ITEM);
    if (!m) {
      if (/^\s+expect:/.test(raw)) continue;
      errors.push(`line ${lineNo}: expected a ${phase === "step" ? "numbered step (1. `tool` key=value)" : "bullet (- `tool` key=value)"}, got: ${raw.trim().slice(0, 80)}`);
      continue;
    }
    const call = (phase === "step" ? m[2] : m[1])!.trim();
    seen += 1;
    const n = first + steps.length;
    if (phase === "step" && Number(m[1]) !== seen) errors.push(`line ${lineNo}: steps must be numbered 1, 2, 3 in order (got ${m[1]})`);
    const cm = call.match(/^`([a-z_]+)`\s*(.*)$/);
    if (!cm) {
      errors.push(`line ${lineNo}: each ${phase} is one tool call in backticks with literal arguments, e.g. \`ship_tasks\` ship=kinwork (free text is not an order step)`);
      continue;
    }
    const tool = cm[1]!;
    const spec = ORDER_TOOLS[tool];
    if (!spec) {
      errors.push(`line ${lineNo}: \`${tool}\` is not an order tool. Allowed: ${Object.keys(ORDER_TOOLS).join(", ")}`);
      continue;
    }
    if (phase === "acceptance" && !spec.read) errors.push(`line ${lineNo}: acceptance lines must be read tools, not \`${tool}\``);
    const args = parseArgs(cm[2]!);
    if (!args) {
      errors.push(`line ${lineNo}: arguments must be key=value or key="quoted value"`);
      continue;
    }
    for (const k of Object.keys(args)) if (!spec.params.includes(k)) errors.push(`line ${lineNo}: \`${tool}\` has no argument ${k} (it takes: ${spec.params.join(", ") || "none"})`);
    for (const k of spec.required) if (!normalizeArg(args[k])) errors.push(`line ${lineNo}: \`${tool}\` needs ${k}=`);
    const exp = lines[i + 1]?.match(/^\s+expect:\s*(.+)$/);
    if (!exp) errors.push(`line ${lineNo}: add an indented "expect:" line under this ${phase}`);
    steps.push({ n, phase, tool, args, expect: exp?.[1]?.trim() ?? "", line: lineNo });
  }
  return steps;
}

export function parseOrder(text: string, file = ""): ParseResult {
  const errors: string[] = [];
  const m = text.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { order: null, meta: null, errors: ["line 1: the note needs YAML frontmatter between --- lines"] };
  let fm: Record<string, unknown> = {};
  try {
    fm = (parseYaml(m[1]!) as Record<string, unknown>) ?? {};
  } catch (e) {
    return { order: null, meta: null, errors: [`frontmatter: ${e instanceof Error ? e.message : "bad YAML"}`] };
  }
  const body = m[2]!;
  const bodyOffset = m[1]!.split("\n").length + 2;
  const str = (k: string) => (fm[k] === undefined || fm[k] === null ? "" : String(fm[k]));
  const status = (str("status") || "queued") as OrderStatus;
  if (!ORDER_STATUSES.includes(status)) errors.push(`frontmatter: status must be one of ${ORDER_STATUSES.join(", ")}`);
  if (!SLUG_RE.test(str("order"))) errors.push("frontmatter: order must be the file stem, yyyy-mm-dd-slug");
  if (!str("title")) errors.push("frontmatter: title is required");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(str("ship"))) errors.push("frontmatter: ship is required (a ship id, or fleet)");
  if (!str("submitted_by")) errors.push("frontmatter: submitted_by is required (claude-code, architect, captain, or an agent id)");
  const shift = (sec: { text: string; offset: number } | null) => (sec ? { ...sec, offset: sec.offset + bodyOffset } : null);
  const stepsSec = shift(section(body, "Steps"));
  if (!stepsSec) errors.push("body: a ## Steps section is required");
  const steps = stepsSec ? parseLines(stepsSec, "step", 1, errors) : [];
  if (stepsSec && !steps.length) errors.push("body: ## Steps has no steps");
  const accSec = shift(section(body, "Acceptance"));
  const acceptance = accSec ? parseLines(accSec, "acceptance", steps.length + 1, errors) : [];
  const meta: OrderMeta = {
    title: str("title"),
    order: str("order"),
    status,
    ship: str("ship"),
    submitted_by: str("submitted_by"),
    created: str("created"),
    ...(str("approved") ? { approved: str("approved") } : {}),
    ...(str("started") ? { started: str("started") } : {}),
    ...(str("ended") ? { ended: str("ended") } : {}),
    ...(str("reason") ? { reason: str("reason") } : {}),
    ...(Number(fm.resume) > 0 ? { resume: Number(fm.resume) } : {}),
  };
  const intent = section(body, "Intent")?.text.trim() ?? "";
  return { order: errors.length ? null : { meta, intent, steps: steps.concat(acceptance), body, file }, errors, meta };
}

/** The note with its frontmatter replaced (body untouched). */
export function withMeta(text: string, meta: OrderMeta): string {
  const body = text.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const lines = META_KEYS.filter((k) => meta[k] !== undefined && meta[k] !== "").map((k) => `${k}: ${typeof meta[k] === "number" ? meta[k] : JSON.stringify(String(meta[k]))}`);
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** Replace (or add) the note's ## Report section. */
export function withReport(text: string, report: string): string {
  const cut = text.search(/^## Report\s*$/m);
  const head = (cut < 0 ? text : text.slice(0, cut)).trimEnd();
  return `${head}\n\n## Report\n\n${report.trim()}\n`;
}

export async function readOrder(slug: string): Promise<ParseResult & { text: string }> {
  const file = orderFile(slug);
  if (!file) return { order: null, meta: null, errors: [`bad order id ${slug}`], text: "" };
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { order: null, meta: null, errors: [`no order ${slug}`], text: "" };
  }
  return { ...parseOrder(text, file), text };
}

/** Every order note, newest first; malformed ones come back with their errors. */
export async function listOrders(): Promise<({ slug: string; text: string } & ParseResult)[]> {
  let names: string[] = [];
  try {
    names = (await readdir(ordersDir())).filter((n) => n.endsWith(".md") && SLUG_RE.test(n.slice(0, -3)));
  } catch {
    return [];
  }
  const out = await Promise.all(names.map(async (n) => ({ slug: n.slice(0, -3), ...(await readOrder(n.slice(0, -3))) })));
  return out.sort((a, b) => b.slug.localeCompare(a.slug));
}

/** Write the note atomically (tmp + rename) so a watcher never reads half a file. */
export async function writeOrderText(slug: string, text: string): Promise<void> {
  const file = orderFile(slug);
  if (!file) throw new Error(`bad order id ${slug}`);
  await mkdir(ordersDir(), { recursive: true });
  await writeFile(file + ".tmp", text, "utf8");
  await rename(file + ".tmp", file);
}

/** Change an order's status (and any other frontmatter fields) in place; works on malformed notes too (to mark them failed). */
export async function updateOrder(slug: string, patch: Partial<OrderMeta>, report?: string): Promise<OrderMeta | null> {
  const r = await readOrder(slug);
  if (!r.meta) return null;
  const meta = { ...r.meta, ...patch };
  for (const k of Object.keys(patch) as (keyof OrderMeta)[]) if (patch[k] === undefined) delete meta[k];
  let text = withMeta(r.text, meta);
  if (report !== undefined) text = withReport(text, report);
  await writeOrderText(slug, text);
  return meta;
}

export function slugFor(title: string, day = new Date().toISOString().slice(0, 10)): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "order";
  return `${day}-${s}`;
}

/** A new order note from a title and a body (## Intent / ## Steps / ## Acceptance). */
export async function createOrder(opts: { title: string; ship: string; by: string; body: string; status?: OrderStatus }): Promise<{ slug: string; errors: string[] }> {
  let slug = slugFor(opts.title);
  for (let i = 2; existsSync(orderFile(slug)!); i++) slug = `${slugFor(opts.title)}-${i}`;
  const meta: OrderMeta = { title: opts.title, order: slug, status: opts.status ?? "queued", ship: opts.ship, submitted_by: opts.by, created: new Date().toISOString() };
  const text = withMeta(`\n${opts.body.trim()}\n`, meta);
  const parsed = parseOrder(text);
  if (parsed.errors.length) return { slug, errors: parsed.errors };
  await writeOrderText(slug, text);
  return { slug, errors: [] };
}

/** Does a fleet tool call match step n exactly (tool and literal arguments)? Null when it does, else why not. */
export function callMismatch(step: OrderStep, tool: string, args: Record<string, unknown>): string | null {
  if (tool !== step.tool) return `step ${step.n} is \`${step.tool}\`, not \`${tool}\``;
  const given = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, normalizeArg(v)]).filter(([, v]) => v !== ""));
  const planned = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, normalizeArg(v)]));
  for (const k of new Set([...Object.keys(given), ...Object.keys(planned)])) {
    if (given[k] !== planned[k]) return `step ${step.n} has ${k}=${planned[k] === undefined ? "(none)" : JSON.stringify(planned[k])}, the call had ${given[k] === undefined ? "(none)" : JSON.stringify(given[k])}`;
  }
  return null;
}

/** Check a body (## Intent / ## Steps / ## Acceptance) as if submitted; one line for the captain. */
export function checkOrderBody(body: string): { ok: boolean; message: string } {
  const meta: OrderMeta = { title: "check", order: "2026-01-01-check", status: "queued", ship: "fleet", submitted_by: "captain", created: "" };
  const { order, errors } = parseOrder(withMeta(`\n${body.trim()}\n`, meta));
  if (errors.length) return { ok: false, message: errors.join(" · ") };
  const steps = order!.steps.filter((s) => s.phase === "step").length;
  const checks = order!.steps.length - steps;
  return { ok: true, message: `Looks right: ${steps} step(s), ${checks} check(s). Submit when ready.` };
}

/** The captain's Go: a queued order becomes approved (the watcher starts it when Alice is free). */
export async function approveOrder(slug: string): Promise<{ ok: boolean; message: string }> {
  const r = await readOrder(slug);
  if (!r.meta) return { ok: false, message: r.errors[0] ?? "No such order." };
  if (r.meta.status !== "queued") return { ok: false, message: `${slug} is ${r.meta.status}; only a queued order takes a Go.` };
  if (!r.order) return { ok: false, message: `${slug} does not parse: ${r.errors[0]}` };
  await updateOrder(slug, { status: "approved", approved: new Date().toISOString() });
  return { ok: true, message: "Go given. Alice starts it when she is free." };
}

/** Retry a paused order from the step it stopped at. */
export async function retryOrder(slug: string): Promise<{ ok: boolean; message: string }> {
  const r = await readOrder(slug);
  if (!r.meta || !r.order) return { ok: false, message: r.errors[0] ?? "No such order." };
  if (r.meta.status !== "needs-captain") return { ok: false, message: `${slug} is ${r.meta.status}; only a paused order can be retried.` };
  await updateOrder(slug, { status: "approved", approved: new Date().toISOString(), reason: undefined });
  return { ok: true, message: `Retrying from step ${r.meta.resume ?? 1}.` };
}

export async function cancelOrder(slug: string): Promise<{ ok: boolean; message: string }> {
  const r = await readOrder(slug);
  if (!r.meta) return { ok: false, message: r.errors[0] ?? "No such order." };
  if (["done", "failed", "cancelled"].includes(r.meta.status)) return { ok: false, message: `${slug} is already ${r.meta.status}.` };
  if (r.meta.status === "running") return { ok: false, message: `${slug} is running. Stop Alice from her chat first; the order then pauses and can be cancelled.` };
  await updateOrder(slug, { status: "cancelled", ended: new Date().toISOString() });
  return { ok: true, message: "Cancelled." };
}

/** Orders that have not started can change: queued, or approved and still waiting for Alice. */
const EDITABLE: OrderStatus[] = ["queued", "approved"];

/** The note's body for editing: Intent, Steps, Acceptance (no frontmatter, no Report). */
export function editableBody(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const cut = body.search(/^## Report\s*$/m);
  return (cut < 0 ? body : body.slice(0, cut)).trim();
}

/** New title and steps for an order that has not started; the body must parse, status and dates stay. */
export async function editOrder(slug: string, title: string, body: string): Promise<{ ok: boolean; message: string }> {
  const r = await readOrder(slug);
  if (!r.meta) return { ok: false, message: r.errors[0] ?? "No such order." };
  if (!EDITABLE.includes(r.meta.status)) return { ok: false, message: `${slug} is ${r.meta.status}; only an order that has not started can be edited.` };
  if (title.trim().length < 3) return { ok: false, message: "Give the order a title." };
  const text = withMeta(`\n${body.trim()}\n`, { ...r.meta, title: title.trim() });
  const parsed = parseOrder(text);
  if (parsed.errors.length) return { ok: false, message: parsed.errors.join(" · ") };
  await writeOrderText(slug, text);
  const steps = parsed.order!.steps.filter((s) => s.phase === "step").length;
  return { ok: true, message: `Saved: ${steps} step(s), ${parsed.order!.steps.length - steps} check(s).` };
}

/** Delete an order that has not started, or one that was cancelled: the note moves to fleet/orders/deleted/. */
export async function deleteOrder(slug: string): Promise<{ ok: boolean; message: string }> {
  const r = await readOrder(slug);
  if (!r.meta) return { ok: false, message: r.errors[0] ?? "No such order." };
  if (![...EDITABLE, "cancelled"].includes(r.meta.status)) return { ok: false, message: `${slug} is ${r.meta.status}; cancel it first, or keep it for its report.` };
  const dir = join(ordersDir(), "deleted");
  await mkdir(dir, { recursive: true });
  await rename(orderFile(slug)!, join(dir, `${slug}.md`));
  return { ok: true, message: "Deleted (the note is in fleet/orders/deleted/)." };
}
