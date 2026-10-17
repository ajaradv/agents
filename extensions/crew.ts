/**
 * crew: tools for ship crewmates to work as a crew, through the dashboard's
 * crew API (dashboard/lib/crew-api.ts). bin/launch loads this for every
 * crewmate (<ship>-<role>) and sets FLEET_SHIP and FLEET_AGENT_ID; the agent
 * host sets FLEET_DASHBOARD_URL.
 *
 * Everyone aboard: voyage_status, crew_message, task_report, run_check (the
 * host commands the captain lists for the ship; FLEET_SHIP_CHECKS names them).
 * The lead (<ship>-lead) also gets: task_add, task_update, maneuver_start.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
    const url = `${base}/api/crew/${encodeURIComponent(ship)}/${path}${method === "GET" ? `?from=${encodeURIComponent(me)}` : ""}`;
    const res = await fetch(url, {
      method,
      // The dashboard knows this process by FLEET_CREW_TOKEN, not by name.
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": process.env.FLEET_CREW_TOKEN ?? "" },
      ...(method === "POST" ? { body: JSON.stringify({ ...body, from: me }) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as Record<string, unknown>;
    if (method === "GET") return JSON.stringify(j, null, 2);
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
    description: "The ship's current voyage: goal, task list with status and assignee, progress, each crewmate's latest activity, the lead's id, and the ship's ADWs.",
    parameters: Type.Object({}),
    async execute() {
      return text(await call("GET", "status"));
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

  if (!isLead) return;

  pi.registerTool({
    name: "task_add",
    label: "Add a voyage task",
    description: "Lead only. Add a task to the voyage. With an assignee (a crewmate id) the task is sent to them now with its detail; without one it waits for you. Write the detail so the crewmate can act without asking: the intent, the files or area, and what done means.",
    parameters: Type.Object({
      title: Type.String({ description: "Short task title" }),
      detail: Type.String({ description: "What to do, where, and what done means" }),
      assignee: Type.Optional(Type.String({ description: "Crewmate id; omit to keep it unassigned" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "tasks", { title: p.title, detail: p.detail, ...(p.assignee ? { assignee: p.assignee } : {}) }));
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update a voyage task",
    description: "Lead only. Change any task's status or note, or reassign it (the new assignee gets the task).",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.Optional(Status),
      note: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String({ description: "Crewmate id to reassign to" })),
    }),
    async execute(_id, p) {
      return text(
        await call("POST", `tasks/${p.id}`, {
          ...(p.status ? { status: p.status } : {}),
          ...(p.note !== undefined ? { note: p.note } : {}),
          ...(p.assignee ? { assignee: p.assignee } : {}),
        }),
      );
    },
  });

  pi.registerTool({
    name: "maneuver_start",
    label: "Launch an SSSF maneuver",
    description: "Lead only. Run one of the ship's SSSF ADWs (voyage_status lists them) for repeatable, gated work such as plan → build → test. The prompt is read by every agent in the chain: state the intent, verified paths, and what done means. It becomes a task; you get a crew message from sssf when it finishes or fails.",
    parameters: Type.Object({
      adw: Type.String({ description: "ADW name, e.g. adw_plan_build_test" }),
      prompt: Type.String(),
    }),
    async execute(_id, p) {
      return text(await call("POST", "maneuvers", { adw: p.adw, prompt: p.prompt }));
    },
  });
}
