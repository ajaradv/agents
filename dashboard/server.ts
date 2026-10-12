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
import { resolveRoute } from "./lib/route.ts";
import { newSession } from "./lib/session-rotate.ts";
import { canvasFileResponse, canvasSignature, canvasViewResponse, listCanvas, withFrameChecks } from "./lib/canvas.ts";
import { scheduleQuotaLoop, usagePartialHtml } from "./lib/quota.ts";
import {
  acceptCaptainLine,
  getAllLastChatTurns,
  getHeadlessChatState,
  registerChatBroadcaster,
  registerChatEventBroadcaster,
  setChatTurnEmitter,
  startChatBridge,
} from "./lib/chat-bridge.ts";
import { abortHost, answerDialog, hostAlive, hostRunning, startHostReaper, stopHost, type HostEvent } from "./lib/agent-host.ts";
import { chatAllowed, chatTarget, listChatTargets, startChatTargetRefresh } from "./lib/chat-targets.ts";
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
    ...(line.questions ? { questions: line.questions } : {}),
    ...(line.dialog ? { dialog: line.dialog } : {}),
  };
}

/** Live RPC-agent events go to open sockets only; they are not saved. */
function broadcastChatEvent(agentId: string, ev: HostEvent) {
  const set = chatSockets.get(agentId);
  if (ev.kind === "running") sseBroadcast("agents");
  if (!set) return;
  const payload = JSON.stringify({ event: ev });
  for (const ws of set) {
    try {
      ws.send(payload);
    } catch {
      set.delete(ws);
    }
  }
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
registerChatEventBroadcaster(broadcastChatEvent);
startHostReaper();

// Canvas: tell the page when an agent's canvas items change (extensions/canvas.ts writes them).
const canvasSigs = new Map<string, string>();
setInterval(() => {
  void (async () => {
    for (const t of listChatTargets().agents) {
      const sig = await canvasSignature(t.id);
      const prev = canvasSigs.get(t.id);
      canvasSigs.set(t.id, sig);
      if (prev !== undefined && prev !== sig) sseBroadcast("canvas", t.id);
    }
  })().catch((e) => console.error("[dashboard] canvas poll:", e));
}, 2000);
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
      // Bun drops connections idle for 10s by default, before the 15s ping;
      // the browser saw ERR_INCOMPLETE_CHUNKED_ENCODING and reconnected.
      server.timeout(req, 0);
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

    const canvasList = path.match(/^\/api\/canvas\/([a-z][a-z0-9_-]{0,63})$/);
    if (canvasList && req.method === "GET") {
      const agentId = canvasList[1]!;
      if (!chatAllowed(agentId)) return Response.json({ items: [] }, { status: 404 });
      return Response.json({ items: await withFrameChecks(await listCanvas(agentId), url.origin) });
    }

    const canvasView = path.match(/^\/canvas\/([a-z][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9-]{0,59})\/view$/);
    if (canvasView && req.method === "GET") {
      return canvasViewResponse(canvasView[1]!, canvasView[2]!);
    }

    const canvasFile = path.match(/^\/canvas\/([a-z][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9-]{0,59})\/(.+)$/);
    if (canvasFile && req.method === "GET") {
      let rel = "";
      try {
        rel = decodeURIComponent(canvasFile[3]!);
      } catch {
        return new Response("not found", { status: 404 });
      }
      return canvasFileResponse(canvasFile[1]!, canvasFile[2]!, rel);
    }

    const hostAbort = path.match(/^\/api\/agents\/([a-z][a-z0-9_-]{0,63})\/abort$/);
    if (hostAbort && req.method === "POST") {
      const agentId = hostAbort[1]!;
      if (!chatAllowed(agentId) || chatTarget(agentId)?.runtime !== "rpc") {
        return Response.json({ ok: false, message: "not a live agent" }, { status: 404 });
      }
      return Response.json({ ok: await abortHost(agentId) });
    }

    const newSess = path.match(/^\/api\/agents\/([a-z][a-z0-9_-]{0,63})\/new-session$/);
    if (newSess && req.method === "POST") {
      const agentId = newSess[1]!;
      if (!chatAllowed(agentId) || !chatTarget(agentId)?.persistentSession) {
        return Response.json({ ok: false, message: "This agent has no shared session." }, { status: 404 });
      }
      return Response.json(await newSession(agentId));
    }

    const dialogAnswer = path.match(/^\/api\/dialog\/([a-z][a-z0-9_-]{0,63})\/([A-Za-z0-9_.:-]{1,128})$/);
    if (dialogAnswer && req.method === "POST") {
      const [, agentId, dialogId] = dialogAnswer;
      if (!chatAllowed(agentId!)) return Response.json({ ok: false, error: "unknown agent" }, { status: 404 });
      let body: { value?: unknown; confirmed?: unknown; cancelled?: unknown } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: "bad json" }, { status: 400 });
      }
      const r = await answerDialog(agentId!, dialogId!, {
        value: typeof body.value === "string" ? body.value.slice(0, 4000) : undefined,
        confirmed: typeof body.confirmed === "boolean" ? body.confirmed : undefined,
        cancelled: body.cancelled === true,
      });
      return Response.json(r, { status: r.ok ? 200 : 409 });
    }

    if (path === "/api/route" && req.method === "POST") {
      let text = "";
      try {
        text = String(((await req.json()) as { text?: string }).text ?? "").trim();
      } catch {
        return Response.json({ status: "error", reason: "bad json", probabilities: [] }, { status: 400 });
      }
      if (!text) return Response.json({ status: "error", reason: "empty message", probabilities: [] }, { status: 400 });
      return Response.json(await resolveRoute(text.slice(0, 8000)));
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
      if (hostRunning(agentId)) {
        return Response.json({
          ok: false,
          message: `${agentId} is working in the dashboard right now. Stop it or let it finish, then start the TUI.`,
        });
      }
      // The TUI resumes the same Pi session; release it from the dashboard host first.
      if (hostAlive(agentId)) await stopHost(agentId);
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

    // Section routes (/health, /fleet, /agents) are the same page; app.js reads the path.
    if (path === "/" || path === "/index.html" || /^\/(health|fleet|agents)\/?$/.test(path)) {
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
