/**
 * fleet: tools for fleet officers (Alice) to see the whole fleet and talk to
 * any agent on it, through the fleet node's fleet API (dashboard/lib/fleet-api.ts).
 * Loaded from agents/<id>/agent.yaml `extensions: [fleet]`. The node knows
 * the caller by FLEET_CREW_TOKEN, which only a live dashboard session has; in
 * the TUI these tools say so instead of guessing.
 *
 * Reads, fleet_chat, and tier 2 fleet actions (voyages, crew, orchestrator,
 * maneuvers, stopping an agent, new sessions). A tier 2 call outside an order
 * is held by the server for the captain's Go (dashboard/lib/go-gate.ts).
 * While an order runs, pass its `order` and `step` with each planned call, log
 * each step with order_step, and close it with order_finish.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const base = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
const token = process.env.FLEET_CREW_TOKEN ?? "";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

async function call(method: "GET" | "POST", what: string, params: Record<string, string | number | undefined> = {}, body?: Record<string, unknown>, timeoutMs = 30_000): Promise<string> {
  if (!base || !token) return "Fleet tools work only in the dashboard's live session (this looks like the TUI). Ask the captain, or read the vault and the inbox instead.";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  try {
    const res = await fetch(`${base}/api/fleet/${what}${q.size ? `?${q}` : ""}`, {
      method,
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": token },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as Record<string, unknown>;
    // Read tools come back already shaped for an agent (dashboard/lib/tool-out.ts).
    if (typeof j.text === "string") return j.text;
    if (method === "GET") return JSON.stringify(j, null, 1);
    return String(j.message ?? (res.ok ? "done" : "failed"));
  } catch (e) {
    return `The fleet node did not answer (${e instanceof Error ? e.message : String(e)}). Tell the captain.`;
  }
}

/**
 * Rarely used tools stay out of the declared tool list (lazy loading): they are
 * listed compactly by codemode, callable from codemode scripts, and declared on
 * demand with tool_search. Only for agents that run with codemode (agent.yaml
 * `tools: [+codemode, +tool_search]`); for others they stay ordinary tools.
 */
const LAZY = process.env.FLEET_LAZY_TOOLS === "1";
const RARE = LAZY ? ({ exposure: "codemode", namespace: { name: "fleet_actions", description: "Fleet actions that change state (each waits for the captain's Go outside an order)" } } as const) : {};

/** Vault edits: lazy like the fleet actions, but they are Alice's own filing, not the captain's Go. */
const RARE_VAULT = LAZY ? ({ exposure: "codemode", namespace: { name: "vault_actions", description: "Vault edits: frontmatter fields and checklist items (never career/ or profile/)" } } as const) : {};

/** Every fleet tool can be a step of a running order. */
const OrderArgs = {
  order: Type.Optional(Type.String({ description: "Running order's id, if any" })),
  step: Type.Optional(Type.Number({ description: "Its step number" })),
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fleet_status",
    label: "Fleet status",
    description:
      "The whole fleet at a glance: ships (voyage, tasks, crew), who is working, what waits on the captain, today's spend. Call it first for fleet questions.",
    parameters: Type.Object({
      detail: Type.Optional(Type.Boolean({ description: "Add per-crewmate activity, officers, workers, spend per agent" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "status", { detail: p.detail ? "true" : undefined, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "ship_log",
    label: "Ship log",
    description: "A ship's log, newest first. Officers are on ship `fleet`.",
    parameters: Type.Object({
      ship: Type.String({ description: "Ship id, e.g. kinwork, or fleet for officers" }),
      limit: Type.Optional(Type.Number({ description: "Rows, default 20, max 200" })),
      kind: Type.Optional(Type.String({ description: "chat-in, chat-out, question, answer, tool, turn-end, notice, task, maneuver" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "log", { ship: p.ship, limit: p.limit, kind: p.kind, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "ship_tasks",
    label: "Ship tasks",
    description: "A ship's open voyage: goal and every task with assignee and status.",
    parameters: Type.Object({ ship: Type.String(), full: Type.Optional(Type.Boolean({ description: "Long text uncut" })), ...OrderArgs }),
    async execute(_id, p) {
      return text(await call("GET", "tasks", { ship: p.ship, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "ship_maneuvers",
    label: "Ship maneuvers",
    description: "A ship's recent SSSF maneuvers (ADW runs): status, phases, errors, cost; plus the ADWs it has.",
    parameters: Type.Object({ ship: Type.String(), full: Type.Optional(Type.Boolean({ description: "Long text uncut" })), ...OrderArgs }),
    async execute(_id, p) {
      return text(await call("GET", "maneuvers", { ship: p.ship, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "agent_chat_read",
    label: "Read an agent's thread",
    description: "Newest lines of any agent's captain thread (where replies to your fleet_chat land).",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent id, e.g. kinwork-designer, architect, firstmate" }),
      n: Type.Optional(Type.Number({ description: "Lines, default 8, max 60 (long lines are shortened)" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "chat", { agent: p.agent, n: p.n, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "vault_tasks",
    label: "Vault tasks",
    description: "The captain's vault tasks (tasks/ notes): what is ready to work on (open, waiting on nothing), what waits on what (blocked_by in a note's frontmatter), what is in progress, sorted by priority then age. Notes it cannot read are listed. id=<note name> gives one task's detail; filter=next lists what is left on the active ones.",
    parameters: Type.Object({
      filter: Type.Optional(StringEnum(["ready", "open", "in-progress", "blocked", "done", "all", "next"] as const, { description: "next: the open Done-when steps of each active task, and which look closeable" })),
      id: Type.Optional(Type.String({ description: "A task's note name, e.g. fleet-tool-standards" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "vault-tasks", { filter: p.filter, id: p.id, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "fleet_query",
    label: "Fleet query",
    description: "Exact numbers from the fleet's records, read-only; use it instead of SQL. spend: turn cost by agent, model, or day. tool_failures: failed tool calls by agent and tool, with totals by tool and day. jev: Jev calls and cost per use, and the compaction advisor. gate: tool gate decisions with mode, counts by agent and day, and the notable ones. voyages: open and recent voyages with ship and cost. The window is days back from now, or since/until as YYYY-MM-DD (UTC, both days inclusive) for a fixed range. A list says \"shown N of M\" when cut: a sample, not totals; limit or full=true shows more.",
    parameters: Type.Object({
      query: StringEnum(["spend", "tool_failures", "jev", "gate", "voyages"] as const),
      days: Type.Optional(Type.Number({ description: "How far back, default 7, max 365; ignored when since is given" })),
      since: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD (UTC, inclusive) or an ISO timestamp" })),
      until: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD (UTC, inclusive) or an ISO timestamp; with no since, days back from it" })),
      by: Type.Optional(StringEnum(["agent", "model", "day"] as const, { description: "spend only: how to group it, default agent" })),
      limit: Type.Optional(Type.Number({ description: "Rows per list, default as now, max 200" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut, every row (lists up to 200)" })),
    }),
    async execute(_id, p) {
      return text(await call("GET", "fleet-query", { query: p.query, days: p.days, since: p.since, until: p.until, by: p.by, limit: p.limit, full: p.full ? "true" : undefined }));
    },
  });

  pi.registerTool({
    name: "vault_search",
    label: "Search the vault",
    description: "Find vault notes by words and/or frontmatter. query matches note sections (with a snippet and the section's heading); type, status, ship, path (a prefix like tasks/, or a glob like fleet/plans/**) filter on frontmatter. Each hit has path, title, summary and the best section. Newest first without a query. Read one with vault_note.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words to find; \"quoted phrase\" for exact" })),
      type: Type.Optional(Type.String({ description: "Frontmatter type, e.g. Task, Plan, Research" })),
      status: Type.Optional(Type.String({ description: "Frontmatter status, e.g. open, done, accepted" })),
      ship: Type.Optional(Type.String({ description: "Frontmatter ship, e.g. fleet, kinwork" })),
      path: Type.Optional(Type.String({ description: "Path prefix (tasks/) or glob (fleet/plans/**)" })),
      limit: Type.Optional(Type.Number({ description: "Notes, default 8, max 25" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
    }),
    async execute(_id, p) {
      return text(await call("GET", "vault-search", { query: p.query, type: p.type, status: p.status, ship: p.ship, path: p.path, limit: p.limit, full: p.full ? "true" : undefined }));
    },
  });

  pi.registerTool({
    name: "vault_note",
    label: "Read a vault note",
    description: "One vault note without reading the file: compact frontmatter, its summary, and the headings with their sizes. section=<heading> (any case) returns just that section; full=true the whole body, cut at 12 KB. Use it before opening a long note.",
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative path, e.g. fleet/plans/research/alice-memory-and-tools.md" }),
      section: Type.Optional(Type.String({ description: "A heading to read, e.g. Phases" })),
      full: Type.Optional(Type.Boolean({ description: "The whole body (cut at 12 KB)" })),
    }),
    async execute(_id, p) {
      return text(await call("GET", "vault-note", { path: p.path, section: p.section, full: p.full ? "true" : undefined }));
    },
  });

  pi.registerTool({
    name: "vault_doctor",
    label: "Check the vault",
    description: "Check the vault's notes: frontmatter that does not parse, Task fields, broken links and blocked_by, the task index. Read-only unless fix=true, which only quotes values that break frontmatter (what bin/vault-doctor --fix does). The rest needs judgement: propose it to the captain.",
    parameters: Type.Object({ fix: Type.Optional(Type.Boolean({ description: "Repair the problems marked fixable" })), full: Type.Optional(Type.Boolean({ description: "Long text uncut" })) }),
    async execute(_id, p) {
      return p.fix ? text(await call("POST", "vault-doctor", {}, { fix: true })) : text(await call("GET", "vault-doctor", { full: p.full ? "true" : undefined }));
    },
  });

  pi.registerTool({
    name: "vault_patch",
    ...RARE_VAULT,
    label: "Patch a vault note",
    description: "Edit one vault note safely. set: frontmatter fields to replace or add (values may be text, numbers, true/false, lists); YAML stays valid and the rest of the file is untouched. check / uncheck: tick or untick the one checklist item whose text contains the given words (an error lists the candidates when none or several match). Refuses career/ and profile/ (the captain's) and paths outside the vault.",
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative note path" }),
      set: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Frontmatter fields to set, e.g. {\"status\": \"done\"}" })),
      check: Type.Optional(Type.String({ description: "Text of the checklist item to tick" })),
      uncheck: Type.Optional(Type.String({ description: "Text of the checklist item to untick" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "vault-patch", {}, { path: p.path, set: p.set, check: p.check, uncheck: p.uncheck }));
    },
  });

  pi.registerTool({
    name: "fact_get",
    label: "Read facts",
    description: "The fleet's recorded facts: exact values that change (a host, a model, an owner, a date), each with its source and since when. Current ones, newest first; subject and key filter. history=true with both gives what it was before (nothing is deleted). observations=true lists your open passing notes instead. Check it before stating such a value from memory.",
    parameters: Type.Object({
      subject: Type.Optional(Type.String({ description: "e.g. hub, alice, kinwork" })),
      key: Type.Optional(Type.String({ description: "e.g. host, model, owner" })),
      history: Type.Optional(Type.Boolean({ description: "The chain of values for one subject and key" })),
      observations: Type.Optional(Type.Boolean({ description: "List open observations (log_observation) instead" })),
      limit: Type.Optional(Type.Number({ description: "Rows, default 50, max 200" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "fact-get", { subject: p.subject, key: p.key, history: p.history ? "true" : undefined, observations: p.observations ? "true" : undefined, limit: p.limit, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "fact_set",
    label: "Record a fact",
    description: "Record an exact value that changes: a host, a model, who owns what, a date. A new value supersedes the old one, which stays in the history; the same value changes nothing. Always give the source (who said it or where you saw it, with the date). Not for preferences (remember) or passing notes (log_observation).",
    parameters: Type.Object({
      subject: Type.String({ description: "What it is about, a-z 0-9 _ . -, e.g. hub" }),
      key: Type.String({ description: "The attribute, e.g. host" }),
      value: Type.String({ description: "The value, up to 500 characters" }),
      source: Type.String({ description: "e.g. captain in chat 2026-10-30" }),
      observation: Type.Optional(Type.Number({ description: "An observation this settles; it stops showing" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("POST", "fact-set", {}, { subject: p.subject, key: p.key, value: p.value, source: p.source, observation: p.observation, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "remember",
    label: "Remember a preference",
    description: "Add one line (a bullet) to a section of the captain's profile, fleet/captain.md: a standing preference or instruction. The section must exist (an error lists them; create=true adds one). To change a standing line give replaces: text matching exactly one bullet in that section. The profile stays under 4 KB: tighten rather than pile up. Ask the captain first for anything they did not say themselves.",
    parameters: Type.Object({
      section: Type.String({ description: "An existing ## heading, any case" }),
      line: Type.String({ description: "One line, up to 300 characters" }),
      replaces: Type.Optional(Type.String({ description: "Text of the one bullet this line replaces" })),
      create: Type.Optional(Type.Boolean({ description: "Add the section when it does not exist" })),
      observation: Type.Optional(Type.Number({ description: "An observation this settles; it stops showing" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("POST", "remember", {}, { section: p.section, line: p.line, replaces: p.replaces, create: p.create ? "true" : undefined, observation: p.observation, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "log_observation",
    label: "Note an observation",
    description: "Note something in passing that may be worth checking later (a model that seems slow, a task that keeps slipping). It shows in fact_get observations=true for ttl_days (default 14, max 90), then stops. Promote it by passing its id to fact_set or remember. Not for values (fact_set) or preferences (remember).",
    parameters: Type.Object({
      text: Type.String({ description: "Up to 300 characters" }),
      subject: Type.Optional(Type.String({ description: "What it is about, e.g. hub" })),
      ttl_days: Type.Optional(Type.Number({ description: "Days to keep showing it, default 14, max 90" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("POST", "log-observation", {}, { text: p.text, subject: p.subject, ttl_days: p.ttl_days, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Full-text search of past fleet talk: every agent's captain thread, helper results, digests, and notices. Use it before asking the captain something they may already have said. Returns snippets with source and time. Not the vault (vault_search).",
    parameters: Type.Object({
      query: Type.String({ description: "Words to find; \"quoted phrase\" for exact" }),
      limit: Type.Optional(Type.Number({ description: "Hits, default 8, max 20" })),
      full: Type.Optional(Type.Boolean({ description: "Long text uncut" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "recall", { query: p.query, limit: p.limit, full: p.full ? "true" : undefined, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "fleet_chat",
    label: "Message an agent",
    description:
      "Message any agent on the rail; starts its turn, marked as from you. Never phrase it as the captain's order unless asked to relay one.",
    parameters: Type.Object({
      to: Type.String({ description: "Agent id" }),
      text: Type.String(),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("POST", "chat", {}, { to: p.to, text: p.text, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Hand a task to a helper",
    description:
      "Hand a self-contained read-only task (summarise notes, survey a repo, collect facts) to a cheap background helper; in the vault it is a librarian. You are woken with a short summary; the full result is in a file. State what to find, where, and what the answer must contain. Helpers cannot write.",
    parameters: Type.Object({
      task: Type.String({ description: "The complete task, self-contained" }),
      where: Type.Optional(Type.String({ description: "vault (default), fleet (the agents repo), or a ship id (its repo)" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "delegate", {}, { task: p.task, where: p.where ?? "vault" }));
    },
  });

  pi.registerTool({
    name: "ask_public",
    label: "Ask the public helper",
    description:
      "Ask a quick question of a free model with no tools and no file access: general knowledge, drafting or rewording, summarising text you paste in. Answers in this call. Only public or general text: free models may train on what they get, so never include vault notes, repo code, chats, names, or secrets (the node refuses text that looks private). Use delegate for anything that needs the vault or a repo.",
    parameters: Type.Object({
      question: Type.String({ description: "The question or instruction, self-contained" }),
      text: Type.Optional(Type.String({ description: "Public text the question is about (optional)" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "public", {}, { question: p.question, text: p.text ?? "" }, 120_000));
    },
  });

  pi.registerTool({
    name: "queue_add",
    label: "Add to the captain's decision queue",
    description:
      "Put something that needs deciding on the captain's Decision queue (the flagship deck): a design session (looks, with the fleet's designer) or a spec session (what to build, with the fleet's architect), before any ship builds it. The captain orders and starts items; chores (fixes, docs, small changes with no new UI or behaviour) sail as voyages without it.",
    parameters: Type.Object({
      kind: StringEnum(["design-session", "spec-session"] as const),
      ship: Type.String({ description: "The ship the decision is for" }),
      title: Type.String({ description: "What needs deciding, in a few words" }),
      request: Type.Optional(Type.String({ description: "What the captain wants out of it, constraints, examples" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "queue", {}, { kind: p.kind, ship: p.ship, title: p.title, request: p.request ?? "" }));
    },
  });

  pi.registerTool({
    name: "notify_captain",
    label: "Notify the captain",
    description:
      "Tell the captain something outside a live chat. done, blocked, decision, milestone interrupt now (unless snoozed); info waits for the morning digest. For results of orders, delegations, and router wakes.",
    parameters: Type.Object({
      kind: StringEnum(["done", "blocked", "decision", "milestone", "info"] as const),
      summary: Type.String({ description: "One spoken sentence: what happened, what they need to do" }),
      detail: Type.Optional(Type.String({ description: "A few lines for the screen" })),
      ref: Type.Optional(Type.String({ description: "Path, order id, or link" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "notify", {}, { kind: p.kind, summary: p.summary, detail: p.detail ?? "", ref: p.ref ?? "" }));
    },
  });

  // Tier 2: fleet actions that change state. Outside an order the server holds
  // each one for the captain's Go and answers "waiting"; end the turn then.
  // Setting sail on an exe.dev VM copies and sets one up (about a minute); docking one pushes, opens the pull request, and removes the VM.
  const SLOW_ACTIONS = new Set(["voyage_start", "voyage_dock"]);
  const action = (tool: string, args: Record<string, unknown>, p: { order?: string; step?: number }) =>
    call("POST", "action", {}, { tool, args: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)), order: p.order, step: p.step }, SLOW_ACTIONS.has(tool) ? 300_000 : 30_000);
  const GO = " Outside an order it waits for the captain's Go: end your turn; the result arrives as a message.";

  pi.registerTool({
    name: "voyage_start",
    ...RARE,
    label: "Set sail",
    description: "Start a voyage on a ship: a goal sent to the crewmate (or Firstmate) who runs it; they get the brief. On lead-run ships a voyage builds decided work: give spec (an approved spec's vault path, fleet/specs/<ship>/<slug>.md), or chore: true for a fix, docs, or a small change with no new UI or behaviour. Anything still to decide goes on the Decision queue (queue_add) first." + GO,
    parameters: Type.Object({
      ship: Type.String(),
      goal: Type.String({ description: "What the voyage should achieve, in one or two sentences" }),
      to: Type.String({ description: "Who runs it: <ship>-lead (usual), another crewmate aboard, or firstmate on Firstmate ships" }),
      on: Type.Optional(StringEnum(["hub", "laptop", "exe"] as const, { description: "Where it sails: hub, laptop (while laptop voyages are on), or exe (an exe.dev VM, while exe.dev voyages are on). Leave out for the ship's default" })),
      spec: Type.Optional(Type.String({ description: "The approved spec it builds (vault path fleet/specs/<ship>/<slug>.md)" })),
      chore: Type.Optional(Type.Boolean({ description: "true for a chore: a fix, docs, or a small change with no new UI or behaviour" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await action("voyage_start", { ship: p.ship, goal: p.goal, to: p.to, on: p.on, spec: p.spec, chore: p.chore ? "true" : undefined }, p));
    },
  });

  pi.registerTool({
    name: "voyage_dock",
    ...RARE,
    label: "Dock a voyage",
    description: "Close a ship's open voyage, with an optional summary for its record." + GO,
    parameters: Type.Object({ ship: Type.String(), summary: Type.Optional(Type.String()), ...OrderArgs }),
    async execute(_id, p) {
      return text(await action("voyage_dock", { ship: p.ship, summary: p.summary }, p));
    },
  });

  pi.registerTool({
    name: "crew_change",
    ...RARE,
    label: "Change a crew",
    description: "Change one thing about a ship's crew: add a role, send one ashore (remove), set a role's daily budget (role + budget in dollars, or none), or a role's model (role + model id, or default)." + GO,
    parameters: Type.Object({
      ship: Type.String(),
      add: Type.Optional(Type.String({ description: "Role to bring aboard, e.g. scout" })),
      remove: Type.Optional(Type.String({ description: "Role to send ashore" })),
      role: Type.Optional(Type.String()),
      budget: Type.Optional(Type.String({ description: "Dollars per day, or none" })),
      model: Type.Optional(Type.String({ description: "Model id, or default" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await action("crew_change", { ship: p.ship, add: p.add, remove: p.remove, role: p.role, budget: p.budget, model: p.model }, p));
    },
  });

  pi.registerTool({
    name: "orchestrator_set",
    ...RARE,
    label: "Set who runs voyages",
    description: "Choose who runs a ship's voyages: firstmate or lead (its own crew)." + GO,
    parameters: Type.Object({ ship: Type.String(), orchestrator: StringEnum(["firstmate", "lead"] as const), ...OrderArgs }),
    async execute(_id, p) {
      return text(await action("orchestrator_set", { ship: p.ship, orchestrator: p.orchestrator }, p));
    },
  });

  pi.registerTool({
    name: "maneuver_start",
    ...RARE,
    label: "Launch a maneuver",
    description: "Launch one of a ship's maneuvers (a checks chain or an SSSF ADW) on a ship under sail, through its lead. For an ADW the prompt is the full brief: intent, files, what done means." + GO,
    parameters: Type.Object({ ship: Type.String(), adw: Type.String({ description: "The maneuver's name, or an ADW (ship_maneuvers lists them)" }), prompt: Type.String(), ...OrderArgs }),
    async execute(_id, p) {
      return text(await action("maneuver_start", { ship: p.ship, adw: p.adw, prompt: p.prompt }, p));
    },
  });

  pi.registerTool({
    name: "agent_abort",
    ...RARE,
    label: "Stop an agent",
    description: "Stop a live agent mid-turn (its work so far stays in its session)." + GO,
    parameters: Type.Object({ agent: Type.String(), ...OrderArgs }),
    async execute(_id, p) {
      return text(await action("agent_abort", { agent: p.agent }, p));
    },
  });

  pi.registerTool({
    name: "agent_new_session",
    ...RARE,
    label: "New session for an agent",
    description: "Start an agent with a shared session on a new, empty history (long sessions make every turn expensive)." + GO,
    parameters: Type.Object({ agent: Type.String(), ...OrderArgs }),
    async execute(_id, p) {
      return text(await action("agent_new_session", { agent: p.agent }, p));
    },
  });

  pi.registerTool({
    name: "order_step",
    label: "Log an order step",
    description:
      "While running a fleet order: record the outcome of step n after making its planned call (ok=true when its expect line holds) or that it cannot be done as written (ok=false with why). Steps are logged in order; none can be skipped.",
    parameters: Type.Object({
      order: Type.String(),
      step: Type.Number(),
      ok: Type.Boolean(),
      result: Type.String({ description: "One line: what came back, or why it cannot be done as written" }),
      evidence: Type.Optional(Type.String({ description: "Event id, task number, timestamp, or path that shows it" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "order-step", {}, { order: p.order, step: p.step, ok: p.ok, result: p.result, evidence: p.evidence ?? "" }));
    },
  });

  pi.registerTool({
    name: "order_finish",
    label: "Finish an order",
    description: 'While running a fleet order: close it. "done" after every step and acceptance check is logged ok; "blocked" (with why) after logging a step as not doable. Then end your turn.',
    parameters: Type.Object({
      order: Type.String(),
      status: StringEnum(["done", "blocked"] as const),
      why: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      return text(await call("POST", "order-finish", {}, { order: p.order, status: p.status, why: p.why ?? "" }));
    },
  });
}
