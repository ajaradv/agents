/**
 * fleet: tools for fleet officers (Alice) to see the whole fleet and talk to
 * any agent on it, through the fleet node's fleet API (dashboard/lib/fleet-api.ts).
 * Loaded from agents/<id>/agent.yaml `extensions: [fleet]`. The node knows
 * the caller by FLEET_CREW_TOKEN, which only a live dashboard session has; in
 * the TUI these tools say so instead of guessing.
 *
 * Phase 1 (reads + fleet_chat). Fleet actions that change state come later
 * behind a captain Go held by the server.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const base = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
const token = process.env.FLEET_CREW_TOKEN ?? "";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

async function call(method: "GET" | "POST", what: string, params: Record<string, string | number | undefined> = {}, body?: Record<string, unknown>): Promise<string> {
  if (!base || !token) return "Fleet tools work only in the dashboard's live session (this looks like the TUI). Ask the captain, or read the vault and the inbox instead.";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  try {
    const res = await fetch(`${base}/api/fleet/${what}${q.size ? `?${q}` : ""}`, {
      method,
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": token },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json()) as Record<string, unknown>;
    return method === "GET" ? JSON.stringify(j, null, 1) : String(j.message ?? (res.ok ? "done" : "failed"));
  } catch (e) {
    return `The fleet node did not answer (${e instanceof Error ? e.message : String(e)}). Tell the captain.`;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fleet_status",
    label: "Fleet status",
    description:
      "One picture of the whole fleet: every ship (voyage goal and task progress, crew status), officers, Firstmate's workers, who is working now, everything waiting on the captain (questions, holds, failed messages), and today's spend per agent. Call it first when a message is about the fleet.",
    parameters: Type.Object({}),
    async execute() {
      return text(await call("GET", "status"));
    },
  });

  pi.registerTool({
    name: "ship_log",
    label: "Ship log",
    description: "A ship's log, newest first: chat in and out, questions, tool steps, turn results with cost, tasks, maneuvers. Officers (you, the Architect, the Designer) are logged on the ship `fleet`. Filter by kind (chat-in, chat-out, question, answer, tool, turn-end, notice, task, maneuver).",
    parameters: Type.Object({
      ship: Type.String({ description: "Ship id, e.g. kinwork, or fleet for officers" }),
      limit: Type.Optional(Type.Number({ description: "Rows, default 40, max 200" })),
      kind: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      return text(await call("GET", "log", { ship: p.ship, limit: p.limit, kind: p.kind }));
    },
  });

  pi.registerTool({
    name: "ship_tasks",
    label: "Ship tasks",
    description: "A ship's open voyage: goal, who it was sent to, and every task with assignee, status, and note.",
    parameters: Type.Object({ ship: Type.String() }),
    async execute(_id, p) {
      return text(await call("GET", "tasks", { ship: p.ship }));
    },
  });

  pi.registerTool({
    name: "ship_maneuvers",
    label: "Ship maneuvers",
    description: "A ship's recent SSSF maneuvers (ADW runs): status, phases, errors, cost; plus the ADWs it has.",
    parameters: Type.Object({ ship: Type.String() }),
    async execute(_id, p) {
      return text(await call("GET", "maneuvers", { ship: p.ship }));
    },
  });

  pi.registerTool({
    name: "agent_chat_read",
    label: "Read an agent's thread",
    description: "The newest lines of the captain's chat thread with any agent on the rail (including replies to your fleet_chat messages).",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent id, e.g. kinwork-designer, architect, firstmate" }),
      n: Type.Optional(Type.Number({ description: "Lines, default 12, max 60" })),
    }),
    async execute(_id, p) {
      return text(await call("GET", "chat", { agent: p.agent, n: p.n }));
    },
  });

  pi.registerTool({
    name: "fleet_chat",
    label: "Message an agent",
    description:
      "Send a message to any agent on the rail (a crewmate, an officer, or Firstmate). It starts that agent's turn; the agent sees it is from you, not the captain. Use it to ask, relay, or hand over context. It does not change fleet state by itself: never phrase it as the captain's order unless the captain asked you to relay one.",
    parameters: Type.Object({
      to: Type.String({ description: "Agent id" }),
      text: Type.String(),
    }),
    async execute(_id, p) {
      return text(await call("POST", "chat", {}, { to: p.to, text: p.text }));
    },
  });
}
