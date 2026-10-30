import { encode } from "@toon-format/toon";

/**
 * What a read tool shows the agent that called it (vault research note
 * axi-evaluation, decision 3; task fleet-tool-standards). The AXI output rules,
 * applied in one place for every harness:
 *
 * - TOON, with lists as tables of a few chosen fields per row;
 * - long text cut with its full size shown, at most MAX_ROWS rows a list, and
 *   `full` to get all of it;
 * - counts with every list, and an explicit "0" instead of an empty list;
 * - errors as `error:` plus what to do;
 * - a few next steps when the next move is not obvious.
 *
 * The node adds the result as `text` to the JSON it already returns; the fleet
 * and crew extensions show `text` when it is there.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

export type View = {
  /** List fields shown as tables: list key -> the fields of each row, in order. */
  rows?: Record<string, string[]>;
  /** Text fields cut to this many characters unless `full`. */
  cut?: Record<string, number>;
  /** Top-level keys never shown (internal or duplicated by the message). */
  hide?: string[];
  /** What an empty list means, by list key. */
  empty?: Record<string, string>;
  /** Next steps, given the result. */
  help?: (res: Res) => string[];
};

const DEFAULT_CUT = 300;
/** Table cells get less room by default: a row is one line among many. */
const DEFAULT_CELL_CUT = 160;
/** Rows shown per list; the rest are counted and the agent is told to narrow. */
export const MAX_ROWS = 60;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** An ISO timestamp as "10-17 20:46" (rows only; the year and seconds rarely matter to an agent). */
function shortTs(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(5, 10)} ${v.slice(11, 16)}` : v;
}

type Cutter = { cut: (field: string, v: string, inCell?: boolean) => string; cutAny: boolean };

function cutter(view: View, full: boolean): Cutter {
  const c: Cutter = {
    cutAny: false,
    cut(field, v, inCell = false) {
      const n = view.cut?.[field] ?? (inCell ? DEFAULT_CELL_CUT : DEFAULT_CUT);
      if (full || v.length <= n) return v;
      c.cutAny = true;
      return `${v.slice(0, n - 1)}… (${v.length} chars)`;
    },
  };
  return c;
}

/** One table cell: primitives as they are, lists joined, objects as short JSON, missing as null. */
function cell(field: string, v: unknown, c: Cutter): string | number | boolean | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return c.cut(field, field === "ts" || field === "started" || field === "updated" || field === "last" ? shortTs(v) : v.replace(/\s+/g, " "), true);
  if (Array.isArray(v)) return v.length ? c.cut(field, v.map((x) => (typeof x === "number" ? `#${x}` : isObj(x) ? JSON.stringify(x) : String(x))).join(" "), true) : null;
  return c.cut(field, JSON.stringify(v), true);
}

function shape(v: unknown, field: string, c: Cutter): unknown {
  if (typeof v === "string") return c.cut(field, v);
  if (Array.isArray(v)) return v.map((x) => shape(x, field, c));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, shape(x, k, c)]));
  return v;
}

/** Render a read tool's result for the agent. */
export function toolText(res: Res, view: View = {}, opts: { full?: boolean } = {}): string {
  if (!res.ok) {
    const help = view.help?.(res) ?? [];
    return encode({ error: res.message, ...(help.length ? { help } : {}) });
  }
  const c = cutter(view, Boolean(opts.full));
  const out: Record<string, unknown> = { result: res.message };
  const hidden: string[] = [];
  for (const [k, v] of Object.entries(res)) {
    if (k === "ok" || k === "message" || k === "text" || view.hide?.includes(k) || v === undefined) continue;
    const fields = view.rows?.[k];
    if (Array.isArray(v)) {
      if (!v.length) {
        out[k] = view.empty?.[k] ?? "0";
        continue;
      }
      if (fields && v.every(isObj)) {
        out[k] = v.slice(0, opts.full ? undefined : MAX_ROWS).map((row) => Object.fromEntries(fields.map((f) => [f, cell(f, row[f], c)])));
        if (v.length > 3) out[`${k}_count`] = v.length;
        if (!opts.full && v.length > MAX_ROWS) hidden.push(`${v.length - MAX_ROWS} more ${k} not shown; narrow the request (a smaller limit, a filter) or pass full=true`);
        continue;
      }
    }
    out[k] = shape(v, k, c);
  }
  const help = [...hidden, ...(view.help?.(res) ?? [])];
  if (c.cutAny) help.push("Long text was cut; call again with full=true for all of it.");
  if (help.length) out.help = help;
  return encode(out);
}

/** The views of the fleet's read tools (fleet.ts for officers, crew.ts for crewmates). */
export const VIEWS: Record<string, View> = {
  fleet_status: {
    rows: {
      ships: ["id", "orchestrator", "mode", "voyage", "crew"],
      officers: ["id", "working", "last"],
      firstmateWorkers: ["id", "project", "status"],
      working: ["id", "doing"],
      needsCaptain: ["id", "kind", "summary"],
    },
    cut: { voyage: 120, last: 120, summary: 160, doing: 120 },
    empty: { working: "0 agents working", needsCaptain: "0 items waiting on the captain", officers: "0 (detail=true lists officers)", firstmateWorkers: "0" },
    help: () => ["ship_tasks <ship> for a voyage's tasks; ship_log <ship> for what happened"],
  },
  ship_log: {
    rows: { events: ["id", "ts", "actor", "kind", "summary"] },
    cut: { summary: 160 },
    empty: { events: "0 events" },
    help: (r) => (Array.isArray(r.events) && r.events.length >= 40 ? ["More happened: pass a larger limit, or kind=<kind> to narrow"] : []),
  },
  ship_tasks: {
    rows: { tasks: ["id", "title", "assignee", "status", "waitingOn", "role"] },
    cut: { title: 100 },
    empty: { tasks: "0 tasks on this voyage" },
    help: (r) => (r.voyage ? ["ship_log <ship> kind=task for task history"] : []),
  },
  ship_maneuvers: {
    rows: { maneuvers: ["id", "adw", "status", "started"], adws: ["name"] },
    empty: { maneuvers: "0 runs", adws: "0 ADWs in the repo", declared: "0 declared" },
  },
  agent_chat_read: {
    rows: { messages: ["ts", "from", "text"] },
    cut: { text: 400 },
    empty: { messages: "0 messages" },
  },
  recall: {
    rows: { hits: ["source", "ts", "snippet"] },
    cut: { snippet: 240 },
    empty: { hits: "0 matches" },
    help: (r) => (Array.isArray(r.hits) && r.hits.length ? ["Read the source note or chat for more; delegate for a deeper search"] : ["Try other words, or delegate a deeper search"]),
  },
  vault_tasks: {
    rows: { tasks: ["id", "title", "status", "priority", "waitingOn"] },
    cut: { title: 110, description: 600 },
    empty: { tasks: "0 tasks in this view" },
    help: (r) =>
      r.task
        ? []
        : [
            "vault_tasks id=<task> for one task's detail (what it waits on and blocks)",
            ...(Array.isArray(r.unreadable) && r.unreadable.length ? ["Unreadable notes have invalid frontmatter (often an unquoted colon); fix them so they count"] : []),
          ],
  },
  vault_next: {
    rows: { tasks: ["id", "status", "priority", "due", "progress", "next", "waitingOn", "closeable"] },
    cut: { next: 500 },
    empty: { tasks: "0 active tasks" },
    help: () => ["vault_tasks id=<task> for one task's detail; vault_note path=tasks/<task>.md for its note"],
  },
  fleet_query: {
    rows: {
      by_agent: ["agent", "turns", "cost", "failed", "tokens"],
      by_model: ["model", "turns", "cost", "failed", "tokens"],
      by_day: ["day", "turns", "cost", "failed", "tokens"],
      by_tool: ["tool", "n"],
      failures_by_day: ["day", "n"],
      by_agent_tool: ["agent", "tool", "n", "last"],
      latest: ["ts", "agent", "tool", "error"],
      uses: ["use", "calls", "failed", "cost", "avg_ms"],
      compaction_advisor: ["agent", "checks", "movedOn", "avgTokensWhenMovedOn"],
      decisions: ["decision", "label", "n"],
      not_allowed_by_agent: ["agent", "n", "decisions"],
      not_allowed_by_day: ["day", "n", "decisions"],
      notable: ["ts", "agent", "decision", "call"],
      voyages: ["id", "ship", "goal", "state", "started", "commits", "turns", "cost"],
    },
    cut: { error: 200, call: 100, goal: 60 },
    empty: { by_agent: "0 turns in this window", by_model: "0 turns in this window", by_day: "0 turns in this window", by_tool: "0", failures_by_day: "0", by_agent_tool: "0", latest: "0", uses: "0 calls", compaction_advisor: "0 checks", decisions: "0", not_allowed_by_agent: "0", not_allowed_by_day: "0", notable: "0", voyages: "0 voyages" },
    help: (r) => (/, by (agent|model|day)$/.test(r.message) ? ["fleet_query query=spend by=agent|model|day; days=N widens the window, since/until=YYYY-MM-DD sets a range"] : []),
  },
  fact_get: {
    rows: { facts: ["id", "subject", "key", "value", "source", "since", "by"], observations: ["id", "text", "subject", "by", "ts", "expires"] },
    cut: { value: 500, text: 300, source: 200, subject: 64, key: 64, by: 32, since: 20, ts: 20, expires: 20 },
    empty: { facts: "0 facts", observations: "0 open observations" },
    help: (r) => (Array.isArray(r.facts) && r.facts.length ? ["fact_get subject=<s> key=<k> history=true for what it was before; fact_set to change one"] : ["fact_set subject key value source to record one"]),
  },
  vault_note: {
    rows: { headings: ["heading", "bytes"] },
    cut: { summary: 400, content: 12_500, body: 12_500 },
    empty: { headings: "0 headings" },
    help: (r) => (r.content || r.body ? [] : ["vault_note path=<note> section=<heading> for one section; full=true for the whole note (cut at 12 KB)"]),
  },
  vault_search: {
    rows: { hits: ["path", "title", "type", "status", "summary", "section", "snippet"] },
    cut: { title: 70, summary: 120, snippet: 200 },
    empty: { hits: "0 notes match" },
    help: (r) => (Array.isArray(r.hits) && r.hits.length ? ["vault_note path=<path> section=<heading> reads one section"] : ["Try other words, or drop a filter (type, status, ship, path)"]),
  },
  vault_doctor: {
    rows: { problems: ["check", "note", "detail", "fixable"] },
    cut: { detail: 200 },
    empty: { problems: "0 problems" },
    help: (r) => (Array.isArray(r.problems) && r.problems.some((p) => (p as { fixable?: boolean }).fixable) ? ["vault_doctor fix=true repairs the ones marked fixable"] : []),
  },
  voyage_status: {
    rows: {
      tasks: ["id", "title", "assignee", "status", "waitingOn", "role", "note"],
      ready: ["id", "title", "assignee", "role"],
      crew: ["id", "working", "last"],
      maneuvers: ["name", "yours", "about"],
    },
    cut: { title: 100, note: 160, last: 120, about: 140 },
    empty: { tasks: "0 tasks yet", ready: "0 ready", maneuvers: "0 declared" },
    help: (r) => {
      const ready = Array.isArray(r.ready) ? (r.ready as { assignee?: string | null }[]) : [];
      return ready.some((t) => !t.assignee) ? ["task_claim <id> takes a ready, unassigned task"] : [];
    },
  },
};

