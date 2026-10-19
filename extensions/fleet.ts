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
    if (method === "GET") return typeof j.text === "string" ? j.text : JSON.stringify(j, null, 1);
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
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "status", { detail: p.detail ? "true" : undefined, order: p.order, step: p.step }));
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
    parameters: Type.Object({ ship: Type.String(), ...OrderArgs }),
    async execute(_id, p) {
      return text(await call("GET", "tasks", { ship: p.ship, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "ship_maneuvers",
    label: "Ship maneuvers",
    description: "A ship's recent SSSF maneuvers (ADW runs): status, phases, errors, cost; plus the ADWs it has.",
    parameters: Type.Object({ ship: Type.String(), ...OrderArgs }),
    async execute(_id, p) {
      return text(await call("GET", "maneuvers", { ship: p.ship, order: p.order, step: p.step }));
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
    description: "The captain's vault tasks (tasks/ notes): what is ready to work on (open, waiting on nothing), what waits on what (blocked_by in a note's frontmatter), what is in progress, sorted by priority then age. Notes it cannot read are listed. id=<note name> gives one task's detail.",
    parameters: Type.Object({
      filter: Type.Optional(StringEnum(["ready", "open", "in-progress", "blocked", "done", "all"] as const)),
      id: Type.Optional(Type.String({ description: "A task's note name, e.g. fleet-tool-standards" })),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await call("GET", "vault-tasks", { filter: p.filter, id: p.id, order: p.order, step: p.step }));
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Full-text search of past fleet talk: every agent's captain thread, helper results, digests, and notices. Use it before asking the captain something they may already have said. Returns snippets with source and time. Not the vault (delegate where=vault for that).",
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
  const action = (tool: string, args: Record<string, unknown>, p: { order?: string; step?: number }) =>
    call("POST", "action", {}, { tool, args: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)), order: p.order, step: p.step });
  const GO = " Outside an order it waits for the captain's Go: end your turn; the result arrives as a message.";

  pi.registerTool({
    name: "voyage_start",
    ...RARE,
    label: "Set sail",
    description: "Start a voyage on a ship: a goal sent to the crewmate (or Firstmate) who runs it; they get the brief." + GO,
    parameters: Type.Object({
      ship: Type.String(),
      goal: Type.String({ description: "What the voyage should achieve, in one or two sentences" }),
      to: Type.String({ description: "Who runs it: <ship>-lead (usual), another crewmate aboard, or firstmate on Firstmate ships" }),
      ...OrderArgs,
    }),
    async execute(_id, p) {
      return text(await action("voyage_start", { ship: p.ship, goal: p.goal, to: p.to }, p));
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
