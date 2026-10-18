import { encode } from "@toon-format/toon";

/**
 * What a read tool shows the agent that called it (vault research note
 * axi-evaluation, decision 3; task fleet-tool-standards). The AXI output rules,
 * applied in one place for every harness:
 *
 * - TOON, with lists as tables of a few chosen fields per row;
 * - long text cut with its full size shown, and `full` to get all of it;
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

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** An ISO timestamp as "10-17 20:46" (rows only; the year and seconds rarely matter to an agent). */
function shortTs(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(5, 10)} ${v.slice(11, 16)}` : v;
}

type Cutter = { cut: (field: string, v: string) => string; cutAny: boolean };

function cutter(view: View, full: boolean): Cutter {
  const c: Cutter = {
    cutAny: false,
    cut(field, v) {
      const n = view.cut?.[field] ?? DEFAULT_CUT;
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
  if (typeof v === "string") return c.cut(field, field === "ts" || field === "started" || field === "updated" ? shortTs(v) : v.replace(/\s+/g, " "));
  if (Array.isArray(v)) return v.length ? c.cut(field, v.map((x) => (typeof x === "number" ? `#${x}` : isObj(x) ? JSON.stringify(x) : String(x))).join(" ")) : null;
  return c.cut(field, JSON.stringify(v));
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
  for (const [k, v] of Object.entries(res)) {
    if (k === "ok" || k === "message" || k === "text" || view.hide?.includes(k) || v === undefined) continue;
    const fields = view.rows?.[k];
    if (Array.isArray(v)) {
      if (!v.length) {
        out[k] = view.empty?.[k] ?? "0";
        continue;
      }
      if (fields && v.every(isObj)) {
        out[k] = v.map((row) => Object.fromEntries(fields.map((f) => [f, cell(f, row[f], c)])));
        if (v.length > 3) out[`${k}_count`] = v.length;
        continue;
      }
    }
    out[k] = shape(v, k, c);
  }
  const help = [...(view.help?.(res) ?? [])];
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

