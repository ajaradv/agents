/**
 * bus: hand-offs between fleet agents through the fleet node (S3b, vault
 * s3-fleet-state-api), for every assistant with a live session's token.
 *
 * - bus_post: one line on another agent's bus (Alice, the architect, an
 *   officer designer); the event router wakes it.
 * - bus_read: new lines on your own bus.
 *
 * They replace appending to and reading fleet/inbox/<agent>/events.jsonl with
 * bash, which needs the hub's disk: an agent on the laptop or in a VM has none.
 * A TUI session (no token) still uses the files, as its role prompt says.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const base = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
const token = process.env.FLEET_CREW_TOKEN ?? "";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

async function call(method: "GET" | "POST", what: "post" | "read", body: Record<string, unknown>): Promise<string> {
  if (!base || !token) return "Bus tools work only in a live dashboard session (this looks like the TUI): use the bus file named in Resolved paths.";
  try {
    const q = method === "GET" ? `?${new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}` : "";
    const res = await fetch(`${base}/api/bus/${what}${q}`, {
      method,
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": token },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json()) as { message?: string; events?: unknown[] };
    if (what === "read") return `${j.message ?? ""}${j.events?.length ? `\n${j.events.map((e) => JSON.stringify(e)).join("\n")}` : ""}`;
    return String(j.message ?? (res.ok ? "posted" : "failed"));
  } catch (e) {
    return `The fleet node did not answer (${e instanceof Error ? e.message : String(e)}). Tell the captain.`;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bus_post",
    label: "Post to a bus",
    description: "Hand off to another fleet agent: one line on its bus (Alice routes work to ship leads; the architect takes plan work). The event router wakes it. Crew on a voyage use crew_message for their ship's crew instead.",
    parameters: Type.Object({
      to: Type.String({ description: "The agent's id, e.g. alice" }),
      kind: Type.String({ description: "A short slug, e.g. plan-ready, design-request, design-needs-done, handoff" }),
      summary: Type.String({ description: "One line: what is ready or needed" }),
      ref: Type.Optional(Type.String({ description: "A vault path, PR, or URL" })),
      ship: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String({ description: "A branch the hand-off is about (design-ship)" })),
    }),
    async execute(_id, p) {
      return text(await call("POST", "post", { ...p }));
    },
  });

  pi.registerTool({
    name: "bus_read",
    label: "Read your bus",
    description: "New lines on your own bus (hand-offs other agents posted to you), oldest first.",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "Only lines after this ISO time (the ts of the last line you handled)" })),
      limit: Type.Optional(Type.Number({ description: "At most this many, default 30" })),
    }),
    async execute(_id, p) {
      return text(await call("GET", "read", { since: p.since, limit: p.limit }));
    },
  });
}
