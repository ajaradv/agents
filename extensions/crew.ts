/**
 * crew: tools for ship crewmates to work as a crew, through the dashboard's
 * crew API (dashboard/lib/crew-api.ts). bin/launch loads this for every
 * crewmate (<ship>-<role>) and sets FLEET_SHIP and FLEET_AGENT_ID; the agent
 * host sets FLEET_DASHBOARD_URL.
 *
 * Everyone aboard: voyage_status, crew_message, task_report, task_claim, run_check (the
 * host commands the captain lists for the ship; FLEET_SHIP_CHECKS names them),
 * and maneuver_start when the ship gives the role maneuvers (FLEET_SHIP_MANEUVERS).
 * The lead (<ship>-lead) also gets: task_add, task_update. The helmsman
 * (<ship>-helmsman) gets helm_propose and fleet_query. Both get git_read
 * (read-only git in the voyage's worktree).
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, statSync } from "node:fs";

const ship = process.env.FLEET_SHIP ?? "";
const me = process.env.FLEET_AGENT_ID ?? "";
const base = (process.env.FLEET_DASHBOARD_URL ?? `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? "8787"}`).replace(/\/$/, "");
const isLead = Boolean(ship) && me === `${ship}-lead`;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>, timeoutMs = 20_000): Promise<string> {
  if (!ship || !me) return "Not aboard a ship in this session (FLEET_SHIP unset).";
  try {
    const url = `${base}/api/crew/${encodeURIComponent(ship)}/${path}${method === "GET" ? `${path.includes("?") ? "&" : "?"}from=${encodeURIComponent(me)}` : ""}`;
    const res = await fetch(url, {
      method,
      // The dashboard knows this process by FLEET_CREW_TOKEN, not by name.
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": process.env.FLEET_CREW_TOKEN ?? "" },
      ...(method === "POST" ? { body: JSON.stringify({ ...body, from: me }) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as Record<string, unknown>;
    // Read tools come back already shaped for an agent (dashboard/lib/tool-out.ts).
    if (method === "GET") return typeof j.text === "string" ? j.text : JSON.stringify(j, null, 2);
    return String(j.message ?? (res.ok ? "done" : "failed"));
  } catch (e) {
    return `The dashboard did not answer (${e instanceof Error ? e.message : String(e)}). Tell the captain in chat instead.`;
  }
}

const Status = StringEnum(["open", "working", "done", "blocked"] as const);

export default function (pi: ExtensionAPI) {
  if (!ship) return;

  pi.registerTool({
    name: "voyage_status",
    label: "Voyage status",
    description: "The ship's current voyage: goal, task list with status, assignee, and what each task waits on, the ready tasks (open, waiting on nothing), progress, each crewmate's latest activity, the lead's id, and the ship's maneuvers and gates.",
    parameters: Type.Object({ full: Type.Optional(Type.Boolean({ description: "Show long notes uncut" })) }),
    async execute(_id, p) {
      return text(await call("GET", p.full ? "status?full=true" : "status"));
    },
  });

  pi.registerTool({
    name: "crew_message",
    label: "Message a crewmate",
    description: "Send a message to another crewmate aboard this ship (ids look like <ship>-<role>; voyage_status lists them). It starts their turn. Use it to ask or hand over context; use task_report to report on a task.",
    parameters: Type.Object({
      to: Type.String({ description: "Crewmate id, e.g. kinwork-designer" }),
      text: Type.String(),
    }),
    async execute(_id, p) {
      return text(await call("POST", "message", { to: p.to, text: p.text }));
    },
  });

  pi.registerTool({
    name: "task_report",
    label: "Report on a task",
    description: "Report on a voyage task assigned to you: working, done, or blocked, with a short summary (what changed, where, what the lead must know). The lead is told.",
    parameters: Type.Object({
      id: Type.Number({ description: "Task number" }),
      status: Status,
      summary: Type.String({ description: "What you did or what blocks you" }),
    }),
    async execute(_id, p) {
      return text(await call("POST", `tasks/${p.id}`, { status: p.status, note: p.summary }));
    },
  });

  pi.registerTool({
    name: "task_claim",
    label: "Claim a ready task",
    description: "Take a ready voyage task (open, unassigned or already yours, waiting on nothing; voyage_status lists them) in one step: it becomes yours and working, and the lead is told. Refused if someone else has it, it is for another role, or it still waits on other tasks.",
    parameters: Type.Object({ id: Type.Number({ description: "Task number" }) }),
    async execute(_id, p) {
      return text(await call("POST", `tasks/${p.id}`, { claim: true }));
    },
  });

  const checks = (process.env.FLEET_SHIP_CHECKS ?? "").split(",").filter((c) => /^[a-z][a-z0-9_-]{0,30}$/.test(c)).sort();
  if (checks.length) {
    pi.registerTool({
      name: "run_check",
      label: "Run a ship check",
      description: `Run one of this ship's checks on the host, in the ship's repo, and get its output (the end of it when long). For checks your own tools cannot run, such as tests that need Docker. You pick the check by name; the command is set by the captain. Checks: ${checks.join(", ")}.`,
      parameters: Type.Object({ name: StringEnum(checks as [string, ...string[]]) }),
      async execute(_id, p) {
        return text(await call("POST", "check", { name: p.name }, 20 * 60_000));
      },
    });
  }

  // Maneuvers this role may launch (bin/launch reads the ship's declarations; the node enforces them).
  const maneuvers = (process.env.FLEET_SHIP_MANEUVERS ?? "").split(",").filter((m) => /^[a-z][a-z0-9_-]{0,40}$/.test(m));
  if (maneuvers.length) {
    pi.registerTool({
      name: "maneuver_start",
      label: "Launch a maneuver",
      description: `Run one of the ship's maneuvers: repeatable, gated work. Yours: ${maneuvers.join(", ")} (voyage_status says what each runs). A checks maneuver runs the ship's checks in order on the latest commit and needs no prompt; an SSSF maneuver needs a full prompt read by every agent in its chain: the intent, verified paths, and what done means. It becomes a task; you get a crew message when it finishes or fails.`,
      parameters: Type.Object({
        maneuver: StringEnum(maneuvers as [string, ...string[]]),
        prompt: Type.Optional(Type.String()),
      }),
      async execute(_id, p) {
        return text(await call("POST", "maneuvers", { maneuver: p.maneuver, prompt: p.prompt ?? "" }));
      },
    });
  }

  // The helmsman reviews the ship's process and files proposals for the captain (dashboard/lib/helm.ts).
  if (me === `${ship}-helmsman`) {
    pi.registerTool({
      name: "helm_propose",
      label: "Propose a process change",
      description:
        "Helmsman only. File one proposal for the captain (Apply or Dismiss in Needs you or on the deck). kind and its fields: check {name, command}; gate {stage, check}; maneuver {name, checks[] or adw, roles[], needs[], gates[]}; retire_maneuver {name}; allow_host {host}; note {text}; tool {name, text} (fleet ship: a tool to fix; becomes a vault task). Always give why.",
      parameters: Type.Object({
        kind: StringEnum(["check", "gate", "maneuver", "retire_maneuver", "allow_host", "note", "tool"] as const),
        why: Type.String(),
        name: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        stage: Type.Optional(StringEnum(["task", "dock"] as const)),
        check: Type.Optional(Type.String()),
        checks: Type.Optional(Type.Array(Type.String())),
        adw: Type.Optional(Type.String()),
        roles: Type.Optional(Type.Array(Type.String())),
        needs: Type.Optional(Type.Array(Type.String())),
        gates: Type.Optional(Type.Array(StringEnum(["task", "dock"] as const))),
        host: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
      async execute(_id, p) {
        return text(await call("POST", "helm", p as Record<string, unknown>));
      },
    });
  }

  // The lead's and helmsman's read-only git, in the voyage's worktree on the ship's host (dashboard/lib/git-read.ts).
  if (isLead || me === `${ship}-helmsman`) {
    pi.registerTool({
      name: "git_read",
      label: "Read git",
      description:
        "Read-only git in the ship's worktree. op: status (short, with the branch), log (n commits, default 10, max 50), diff (working tree, or against ref; paths narrows it), show (a commit, default HEAD; paths narrows it), branch (the current branch name). ref is a branch, tag, sha, or range like main..HEAD; paths are relative to the worktree. Long output is cut.",
      parameters: Type.Object({
        op: StringEnum(["status", "log", "diff", "show", "branch"] as const),
        n: Type.Optional(Type.Number({ description: "log: how many commits" })),
        ref: Type.Optional(Type.String({ description: "diff or show: the ref or range" })),
        paths: Type.Optional(Type.Array(Type.String(), { description: "diff or show: only these paths, relative to the worktree" })),
      }),
      async execute(_id, p) {
        return text(await call("POST", "git", { op: p.op, n: p.n, ref: p.ref, paths: p.paths }));
      },
    });
  }

  // The helmsman reviews with the fleet's numbers instead of SQL over the metrics database (the officers' fleet_query, read-only).
  if (me === `${ship}-helmsman`) {
    pi.registerTool({
      name: "fleet_query",
      label: "Fleet query",
      description:
        "Exact numbers from the fleet's records, read-only; use it instead of SQL. spend: turn cost by agent, model, or day. tool_failures: failed tool calls by agent and tool. jev: Jev calls and cost per use. gate: tool gate decisions. voyages: open and recent voyages with ship and cost. The window is days back from now, or since/until as YYYY-MM-DD (UTC, inclusive). A list says \"shown N of M\" when cut: limit or full=true shows more.",
      parameters: Type.Object({
        query: StringEnum(["spend", "tool_failures", "jev", "gate", "voyages"] as const),
        days: Type.Optional(Type.Number({ description: "How far back, default 7, max 365; ignored when since is given" })),
        since: Type.Optional(Type.String({ description: "First day, YYYY-MM-DD (UTC, inclusive)" })),
        until: Type.Optional(Type.String({ description: "Last day, YYYY-MM-DD (UTC, inclusive)" })),
        by: Type.Optional(StringEnum(["agent", "model", "day"] as const, { description: "spend only: how to group it, default agent" })),
        limit: Type.Optional(Type.Number({ description: "Rows per list, max 200" })),
        full: Type.Optional(Type.Boolean({ description: "Long text uncut, every row" })),
      }),
      async execute(_id, p) {
        const q = new URLSearchParams({ query: p.query });
        for (const [k, v] of Object.entries({ days: p.days, since: p.since, until: p.until, by: p.by, limit: p.limit, full: p.full ? "true" : undefined })) if (v !== undefined) q.set(k, String(v));
        return text(await call("GET", `fleet-query?${q}`));
      },
    });
  }

  pi.registerTool({
    name: "look",
    label: "Look at screenshots",
    description: "Crew eyes: ask a vision model a specific question about up to 4 screenshots, and get a plain description back (your own model may not see images). Take the screenshots first with bash: `bin/fleet-shot <url> --both` (desktop and phone; prints the PNG paths). Ask about what should be visible: elements, text, colours, positions, overlap, what looks broken. Use it before reporting UI work done.",
    parameters: Type.Object({
      images: Type.Array(Type.String(), { description: "PNG/JPEG/WebP paths from bin/fleet-shot (worktree or temp folders)" }),
      question: Type.String({ description: "What to check, specifically" }),
    }),
    async execute(_id, p) {
      // On a ship host away from the node (the laptop, FLEET_HOSTED), the node cannot read these paths: send the images.
      if (process.env.FLEET_HOSTED) {
        const inline: { name: string; data: string }[] = [];
        for (const path of p.images.slice(0, 4)) {
          try {
            if (statSync(path).size > 8 * 1024 * 1024) return text(`${path} is over 8 MB.`);
            inline.push({ name: path.split("/").pop() ?? "image.png", data: readFileSync(path).toString("base64") });
          } catch {
            return text(`${path} does not exist on this machine.`);
          }
        }
        return text(await call("POST", "look", { inline, question: p.question }));
      }
      return text(await call("POST", "look", { images: p.images, question: p.question }));
    },
  });

  pi.registerTool({
    name: "helper",
    label: "Helper",
    description:
      "Hand one short job to a helper: a fresh, cheap model that runs once on the host the fleet picks (the laptop while it is up, so the hub keeps its memory) and reports back, with nothing left running. ui-check: give urls (one or two pages the fleet screenshots at desktop and phone size) and a specific question about what is visible. test-runner: give check (one of the ship's checks); it runs where the voyage's repo is, and when it fails, the helper says the likely cause and where to look.",
    parameters: Type.Object({
      helper: StringEnum(["ui-check", "test-runner"] as const),
      task: Type.String({ description: "What to find out, specifically" }),
      urls: Type.Optional(Type.Array(Type.String(), { description: "ui-check: the page(s), http(s), at most two; reachable from the laptop (a tailnet or public address, not 127.0.0.1 on the hub)" })),
      check: Type.Optional(Type.String({ description: "test-runner: the check's name" })),
      host: Type.Optional(StringEnum(["auto", "hub", "laptop"] as const, { description: "Default auto" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "helper", { helper: p.helper, task: p.task, urls: p.urls, check: p.check, host: p.host ?? "auto" }, 40 * 60_000));
    },
  });

  if (!isLead) return;

  pi.registerTool({
    name: "task_add",
    label: "Add a voyage task",
    description: "Lead only. Add a task to the voyage. With an assignee (a crewmate id) the task is sent to them now with its detail; without one it waits for you or for a crewmate to claim it. With blocked_by (task numbers) it waits until those are done, then goes to its assignee (or becomes claimable) automatically: plan a whole voyage up front this way. Write the detail so the crewmate can act without asking: the intent, the files or area, and what done means.",
    parameters: Type.Object({
      title: Type.String({ description: "Short task title" }),
      detail: Type.String({ description: "What to do, where, and what done means" }),
      assignee: Type.Optional(Type.String({ description: "Crewmate id; omit to keep it unassigned" })),
      blocked_by: Type.Optional(Type.Array(Type.Number(), { description: "Task numbers that must be done first" })),
      role: Type.Optional(Type.String({ description: "Crew role that may take it (e.g. designer for UI work); only that role can claim or be assigned it" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "tasks", { title: p.title, detail: p.detail, ...(p.assignee ? { assignee: p.assignee } : {}), ...(p.blocked_by?.length ? { blockedBy: p.blocked_by } : {}), ...(p.role ? { role: p.role } : {}) }));
    },
  });

  pi.registerTool({
    name: "voyage_dock",
    label: "Ask to dock the voyage",
    description: "Lead only. When every task is done and checked (or the captain says to dock), ask the captain to dock: a Go request in Needs you with your summary. On Go the voyage docks, its worktree is returned (your turn ends with it), and the helmsman reviews. Never dock through the dashboard's API with curl.",
    parameters: Type.Object({ summary: Type.String({ description: "What the voyage delivered and how it was checked (tests, smoke checks), in a few sentences" }) }),
    async execute(_id, p) {
      return text(await call("POST", "dock-request", { summary: p.summary }));
    },
  });

  pi.registerTool({
    name: "queue_request",
    label: "File a decision for the captain's queue",
    description: "Lead only. When the goal asks for options, variants, ideas, or a direction rather than something decided, ask the captain first (ask_captain: explore together first, or build as asked?). To explore, file it here: design (looks, with the fleet's designer) or spec (what to build, with the fleet's architect). The captain starts the session from the flagship's Decision queue; the voyage waits for the spec.",
    parameters: Type.Object({
      kind: StringEnum(["design", "spec"] as const),
      title: Type.String({ description: "What needs deciding, in a few words (Search page redesign)" }),
      request: Type.String({ description: "What the captain asked for and why, constraints, examples to look at" }),
    }),
    async execute(_id, p) {
      return text(await call("POST", "queue-request", { kind: p.kind, title: p.title, request: p.request }));
    },
  });

  pi.registerTool({
    name: "crew_request",
    label: "Request a crew role",
    description: "Lead only. Ask the captain to bring a role aboard that the voyage needs and the ship lacks (for example builder for code: logic, server, tests). It becomes a Go request in the captain's Needs you; on Go the role comes aboard and you get a message. Say why in one sentence. End your turn after asking; do not give the work to a role that does not fit it while you wait.",
    parameters: Type.Object({
      role: Type.String({ description: "The crew role to bring aboard (e.g. builder, scout, designer)" }),
      why: Type.String({ description: "One sentence: what the voyage needs this role for" }),
    }),
    async execute(_id, p) {
      return text(await call("POST", "crew-request", { role: p.role, why: p.why }));
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update a voyage task",
    description: "Lead only. Change any task's status or note, reassign it (the new assignee gets the task, or gets it once what it waits on is done), or change what it waits on (blocked_by: the full list; [] for nothing).",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.Optional(Status),
      note: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String({ description: "Crewmate id to reassign to" })),
      blocked_by: Type.Optional(Type.Array(Type.Number(), { description: "Task numbers it waits on, replacing the current list" })),
    }),
    async execute(_id, p) {
      return text(
        await call("POST", `tasks/${p.id}`, {
          ...(p.status ? { status: p.status } : {}),
          ...(p.note !== undefined ? { note: p.note } : {}),
          ...(p.assignee ? { assignee: p.assignee } : {}),
          ...(p.blocked_by ? { blockedBy: p.blocked_by } : {}),
        }),
      );
    },
  });


}
