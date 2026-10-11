import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  startAgentTui,
  stopAgentTui,
  setLifecycleEmitter,
} from "./lib/alice-control.ts";
import { isTuiAgent } from "./lib/herdr.ts";
import { agentsSidebarHtml } from "./lib/partials.ts";
import { agentsStatusJson } from "./lib/agents-api.ts";
import {
  appendCaptainChat,
  chatAllowed,
  readCaptainChat,
  type ChatLine,
} from "./lib/chat.ts";
import { metricsStripHtml } from "./lib/bus.ts";
import { fleetStripHtml } from "./lib/fleet-snapshot.ts";
import { answerCaptainHold } from "./lib/hold-answer.ts";
import { deleteGroup, readGroups, saveGroup, type GroupInput } from "./lib/groups.ts";
import { groupAdwSectionHtml, groupsPanelHtml } from "./lib/group-partials.ts";
import { scheduleQuotaLoop, usagePartialHtml } from "./lib/quota.ts";
import {
  acceptCaptainLine,
  getAllLastChatTurns,
  getHeadlessChatState,
  registerChatBroadcaster,
  setChatTurnEmitter,
  startChatBridge,
} from "./lib/chat-bridge.ts";
import { listChatTargets, startChatTargetRefresh } from "./lib/chat-targets.ts";
import { HOST, PORT, ROOT } from "./lib/paths.ts";

type WsData = { agentId: string };
const chatSockets = new Map<string, Set<WebSocket>>();
const sseEncoder = new TextEncoder();
type SseController = ReadableStreamDefaultController<Uint8Array>;
const sseClients = new Set<SseController>();

function sseBytes(text: string): Uint8Array {
  return sseEncoder.encode(text);
}

function chatPayload(line: ChatLine) {
  return {
    role: line.from,
    kind: line.kind,
    text: line.text,
    ts: line.ts,
    ...(line.ref ? { ref: line.ref } : {}),
  };
}

function broadcastChat(agentId: string, line: ChatLine) {
  const set = chatSockets.get(agentId);
  if (!set) return;
  const payload = JSON.stringify(chatPayload(line));
  for (const ws of set) {
    try {
      ws.send(payload);
    } catch {
      set.delete(ws);
    }
  }
}

export function sseBroadcast(event: string, data = "") {
  const frame = sseBytes(`event: ${event}\ndata: ${data}\n\n`);
  for (const c of sseClients) {
    try {
      c.enqueue(frame);
    } catch {
      sseClients.delete(c);
    }
  }
}

setLifecycleEmitter(() => {
  sseBroadcast("agents");
});

scheduleQuotaLoop(() => {
  try {
    sseBroadcast("usage");
    sseBroadcast("agents");
  } catch (e) {
    console.error("[dashboard] quota SSE:", e);
  }
});

registerChatBroadcaster(broadcastChat);
setChatTurnEmitter(() => sseBroadcast("agents"));
void startChatTargetRefresh(() => sseBroadcast("rail")).then(() => startChatBridge());

process.on("unhandledRejection", (reason) => {
  console.error("[dashboard] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[dashboard] uncaughtException:", err);
});

const publicDir = join(import.meta.dir, "public");

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    try {
      return await handleFetch(req, server);
    } catch (e) {
      console.error("[dashboard] request error:", e);
      return new Response("internal error", { status: 500 });
    }
  },
  websocket: {
    open(ws) {
      const data = ws.data as WsData;
      if (data.agentId === "voice") {
        ws.send(JSON.stringify({ error: "not configured", hint: "Gemini Live voice later" }));
        ws.close();
        return;
      }
      if (!chatSockets.has(data.agentId)) {
        chatSockets.set(data.agentId, new Set());
      }
      chatSockets.get(data.agentId)!.add(ws);
      readCaptainChat(data.agentId, 50).then((lines) => {
        for (const line of lines) {
          ws.send(JSON.stringify(chatPayload(line)));
        }
      }).catch((e) => console.error("[dashboard] ws history:", e));
    },
    message(ws, message) {
      const data = ws.data as WsData;
      const text = message.toString();
      appendCaptainChat(data.agentId, text)
        .then((line) => {
          broadcastChat(data.agentId, line);
          return acceptCaptainLine(data.agentId, line);
        })
        .catch(() => {
          ws.send(JSON.stringify({ error: "send failed" }));
        });
    },
    close(ws) {
      const data = ws.data as WsData;
      chatSockets.get(data.agentId)?.delete(ws);
    },
  },
});

async function handleFetch(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/ws/chat/")) {
      const agentId = path.split("/").pop() ?? "";
      if (!chatAllowed(agentId)) {
        return new Response("forbidden", { status: 403 });
      }
      if (server.upgrade(req, { data: { agentId } as WsData })) {
        return undefined as unknown as Response;
      }
      return new Response("upgrade failed", { status: 500 });
    }

    if (path === "/ws/voice/alice") {
      if (server.upgrade(req, { data: { agentId: "voice" } as WsData })) {
        return undefined as unknown as Response;
      }
      return new Response("upgrade failed", { status: 500 });
    }

    if (path === "/events" && req.method === "GET") {
      let ctrl: SseController | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
          sseClients.add(controller);
          try {
            controller.enqueue(sseBytes(": connected\n\n"));
          } catch {
            sseClients.delete(controller);
            return;
          }
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(sseBytes(": ping\n\n"));
            } catch {
              sseClients.delete(controller);
              if (heartbeat) clearInterval(heartbeat);
            }
          }, 15_000);
        },
        cancel() {
          if (heartbeat) clearInterval(heartbeat);
          if (ctrl) sseClients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (path === "/api/agents" && req.method === "GET") {
      return Response.json(await agentsStatusJson());
    }

    if (path === "/api/chat-targets" && req.method === "GET") {
      const { agents, workers } = listChatTargets();
      const withTurn = <T extends { id: string }>(t: T) => ({
        ...t,
        ...getHeadlessChatState(t.id),
      });
      return Response.json({
        agents: agents.map(withTurn),
        workers: workers.map(withTurn),
      });
    }

    if (path === "/api/chat-turns" && req.method === "GET") {
      return Response.json({ turns: getAllLastChatTurns() });
    }

    if (path === "/partials/usage" && req.method === "GET") {
      return new Response(await usagePartialHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/partials/metrics" && req.method === "GET") {
      return new Response(await metricsStripHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const holdAnswer = path.match(/^\/api\/holds\/([a-z][a-z0-9-]{0,63})\/answer$/);
    if (holdAnswer && req.method === "POST") {
      const taskId = holdAnswer[1]!;
      let text = "";
      try {
        const type = req.headers.get("content-type") ?? "";
        if (type.includes("application/json")) {
          const body = (await req.json()) as { text?: string };
          text = body.text ?? "";
        } else {
          const form = await req.formData();
          text = String(form.get("text") ?? "");
        }
      } catch {
        return new Response('<p class="warn">Could not read that answer.</p>', {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const result = await answerCaptainHold(taskId, text);
      if (result.ok) sseBroadcast("agents");
      return new Response(result.html, {
        status: result.status,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/partials/fleet" && req.method === "GET") {
      const [strip, adw] = await Promise.all([fleetStripHtml(), groupAdwSectionHtml()]);
      return new Response(adw ? `${strip}<div class="stack group-adw">${adw}</div>` : strip, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/partials/groups" && req.method === "GET") {
      return new Response(await groupsPanelHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/groups" && req.method === "GET") {
      return Response.json({ groups: await readGroups() });
    }

    if (path === "/api/groups" && req.method === "POST") {
      let input: GroupInput = {};
      const type = req.headers.get("content-type") ?? "";
      try {
        if (type.includes("application/json")) {
          input = (await req.json()) as GroupInput;
        } else {
          const form = await req.formData();
          const [adwShip, adwChain] = String(form.get("adw") ?? "").split("::");
          input = {
            id: form.get("id") ? String(form.get("id")) : undefined,
            name: String(form.get("name") ?? ""),
            lead: String(form.get("lead") ?? ""),
            members: form.getAll("members").map(String),
            adwShip,
            adwChain,
          };
        }
      } catch {
        return new Response('<p class="warn">Could not read that group.</p>', {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const r = await saveGroup(input);
      if (r.group) {
        sseBroadcast("rail");
        sseBroadcast("agents");
      }
      if (type.includes("application/json")) {
        return Response.json(r.group ? { ok: true, group: r.group } : { ok: false, error: r.error }, { status: r.group ? 200 : 400 });
      }
      return new Response(await groupsPanelHtml(r.error ?? ""), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const groupDelete = path.match(/^\/api\/groups\/([a-z][a-z0-9-]{0,40})\/delete$/);
    if (groupDelete && req.method === "POST") {
      await deleteGroup(groupDelete[1]!);
      sseBroadcast("rail");
      sseBroadcast("agents");
      return new Response(await groupsPanelHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/partials/agents" && req.method === "GET") {
      return new Response(await agentsSidebarHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const agentStart = path.match(/^\/agents\/([a-z]+)\/start$/);
    if (agentStart && req.method === "POST") {
      const agentId = agentStart[1]!;
      if (!isTuiAgent(agentId)) {
        return Response.json({ ok: false, message: "unknown agent" }, { status: 404 });
      }
      const r = startAgentTui(agentId);
      sseBroadcast("agents");
      return Response.json(r);
    }

    const agentStop = path.match(/^\/agents\/([a-z]+)\/stop$/);
    if (agentStop && req.method === "POST") {
      const agentId = agentStop[1]!;
      if (!isTuiAgent(agentId)) {
        return Response.json({ ok: false, message: "unknown agent" }, { status: 404 });
      }
      const r = stopAgentTui(agentId);
      sseBroadcast("agents");
      return Response.json(r);
    }

    if (path.startsWith("/chat/") && req.method === "POST") {
      const agentId = path.replace("/chat/", "");
      let body: { text?: string };
      try {
        body = (await req.json()) as { text?: string };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      try {
        const line = await appendCaptainChat(agentId, body.text ?? "");
        broadcastChat(agentId, line);
        await acceptCaptainLine(agentId, line);
        return Response.json({ ok: true, line });
      } catch (e) {
        return Response.json(
          { ok: false, error: e instanceof Error ? e.message : "error" },
          { status: 400 },
        );
      }
    }

    if (path.startsWith("/chat/") && req.method === "GET") {
      const agentId = path.replace("/chat/", "");
      const lines = await readCaptainChat(agentId);
      return Response.json({ lines });
    }

    if (path === "/" || path === "/index.html") {
      const html = await readFile(join(publicDir, "index.html"), "utf8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const filePath = join(publicDir, path.replace(/^\//, ""));
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("not found", { status: 404 });
}

console.error(`dashboard http://${HOST}:${PORT} (repo ${ROOT})`);

export default server;
