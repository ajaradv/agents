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
  appendChatError,
  findSentLine,
  readCaptainChat,
  type ChatLine,
} from "./lib/chat.ts";
import { metricsStripHtml } from "./lib/bus.ts";
import { collectCaptainHolds, fleetStripHtml, lastFleetSnapshot } from "./lib/fleet-snapshot.ts";
import { collectNeedsYou, dismissNeed } from "./lib/needs-you.ts";
import { approveOrder, cancelOrder, retryOrder } from "./lib/order-note.ts";
import { answerCaptainHold } from "./lib/hold-answer.ts";
import { deleteGroup, readGroups, saveGroup, type GroupInput } from "./lib/groups.ts";
import { groupAdwSectionHtml, groupsPanelHtml } from "./lib/group-partials.ts";
import { resolveRoute } from "./lib/route.ts";
import { loadAgents } from "./lib/agents.ts";
import { speakable, speechParts, sttAvailable, synthesize, transcribe, ttsState, voiceFor } from "./lib/voice.ts";
import { onShipLogWrite } from "./lib/ship-log.ts";
import { harborHtml, shipDeckHtml } from "./lib/ship-view.ts";
import { dockVoyage, findShip, registerShip, setCrew, setOrchestrator, startVoyage, voyageBrief } from "./lib/shipyard.ts";
import { canvasFileResponse, canvasSignature, canvasViewResponse, listCanvas, withFrameChecks } from "./lib/canvas.ts";
import { scheduleQuotaLoop, usagePartialHtml } from "./lib/quota.ts";
import type { HostEvent } from "./lib/agent-host.ts";
import {
  abortHost,
  answerDialog,
  getAllLastChatTurns,
  getHeadlessChatState,
  hostAlive,
  hostRunning,
  hostWaiting,
  decideGo,
  kickNodeOrders,
  newSession,
  refreshNodeTargets,
  startNodeLink,
  stopHost,
  submitCaptainLine,
} from "./lib/node-client.ts";
import { chatAllowed, chatTarget, listChatTargets, refreshAgentTargets, startChatTargetRefresh } from "./lib/chat-targets.ts";
import { HOST, PORT, ROOT } from "./lib/paths.ts";
import { requestRefusal } from "./lib/request-guard.ts";
import { dashLog } from "./lib/log.ts";

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
    ...(line.go ? { go: line.go } : {}),
  };
}

/** Live RPC-agent events go to open sockets only; they are not saved. */
function broadcastChatEvent(agentId: string, ev: HostEvent) {
  const set = chatSockets.get(agentId);
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
  needsChanged();
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

// Needs you: any new chat line may open or close an item (a question, an
// answer, a failed send); holds change with Firstmate's snapshot.
let needsTimer: ReturnType<typeof setTimeout> | null = null;
function needsChanged() {
  if (needsTimer) return;
  needsTimer = setTimeout(() => {
    needsTimer = null;
    sseBroadcast("needs");
  }, 300);
}
function currentHolds() {
  const snap = lastFleetSnapshot();
  return snap ? collectCaptainHolds(snap) : [];
}
let holdSig = "";
setInterval(() => {
  const sig = currentHolds().map((h) => h.id).join(",");
  if (sig !== holdSig) {
    holdSig = sig;
    needsChanged();
  }
}, 5000);

// Ship's log writes come in bursts (tool steps); tell pages at most every 1.5s per ship.
const shipPending = new Map<string, ReturnType<typeof setTimeout>>();
function shipChanged(ship: string) {
  if (shipPending.has(ship)) return;
  shipPending.set(
    ship,
    setTimeout(() => {
      shipPending.delete(ship);
      sseBroadcast("ship", ship);
    }, 1500),
  );
}
onShipLogWrite(shipChanged);

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

// Agents run in the fleet node (node.ts); its stream feeds the chat sockets and SSE.
startNodeLink({
  line: broadcastChat,
  host: broadcastChatEvent,
  state: () => sseBroadcast("agents"),
  ship: shipChanged,
  rail: () => {
    // A crew change in the node (Alice's crew_change after a Go): re-read crews here too.
    void refreshAgentTargets().then(() => sseBroadcast("rail"));
  },
  go: () => needsChanged(),
  orders: () => {
    sseBroadcast("ship", "");
    needsChanged();
  },
});

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
// The node archives ended worker threads; the dashboard only reads the targets.
void startChatTargetRefresh(() => sseBroadcast("rail"), { archive: false });

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
    const refusal = requestRefusal(req, PORT);
    if (refusal) {
      void dashLog("guard", `refused ${req.method} ${new URL(req.url).pathname}: ${refusal}`);
      return new Response("forbidden", { status: 403 });
    }
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
      const { text, requestId } = parseWsSend(message.toString());
      captainSend(data.agentId, text, requestId)
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

const sendsInFlight = new Map<string, Promise<ChatLine>>();

/**
 * One captain send, at most once per requestId: a retry (flaky phone link,
 * reconnecting socket) gets the line already sent instead of a second turn.
 */
async function captainSend(agentId: string, text: string, requestId?: string): Promise<{ line: ChatLine; duplicate: boolean }> {
  const key = requestId ? `${agentId}\u0000${requestId}` : "";
  const pending = key ? sendsInFlight.get(key) : undefined;
  if (pending) return { line: await pending, duplicate: true };
  const work = (async () => {
    const prior = requestId ? await findSentLine(agentId, requestId) : null;
    if (prior) return { line: prior, duplicate: true };
    const line = await appendCaptainChat(agentId, text, requestId);
    broadcastChat(agentId, line);
    await handToNode(agentId, line);
    return { line, duplicate: false };
  })();
  if (!key) return work;
  const linePromise = work.then((r) => r.line);
  sendsInFlight.set(key, linePromise);
  try {
    return await work;
  } finally {
    sendsInFlight.delete(key);
  }
}

/** Give a saved captain line to the node; if it cannot take it, say so in the thread. */
async function handToNode(agentId: string, line: ChatLine): Promise<void> {
  const error = await submitCaptainLine(agentId, line);
  if (error) broadcastChat(agentId, await appendChatError(agentId, error, line.ts));
}

/** WebSocket sends are JSON {text, requestId} from current pages, plain text from older ones. */
function parseWsSend(raw: string): { text: string; requestId?: string } {
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { text?: unknown; requestId?: unknown };
      if (typeof j.text === "string") return { text: j.text, ...(typeof j.requestId === "string" ? { requestId: j.requestId } : {}) };
    } catch {
      /* plain text that happens to start with { */
    }
  }
  return { text: raw };
}

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
      // waiting: blocked on the captain (open dialog, or a question as its newest line).
      const withTurn = async <T extends { id: string }>(t: T) => {
        const last = hostWaiting(t.id) ? null : (await readCaptainChat(t.id, 1).catch(() => []))[0];
        return {
          ...t,
          ...getHeadlessChatState(t.id),
          waiting: hostWaiting(t.id) || last?.kind === "question",
        };
      };
      return Response.json({
        agents: await Promise.all(agents.map(withTurn)),
        workers: await Promise.all(workers.map(withTurn)),
      });
    }

    if (path === "/api/needs-you" && req.method === "GET") {
      return Response.json({ items: await collectNeedsYou({ waiting: hostWaiting, holds: currentHolds() }) });
    }

    if (path === "/api/needs-you/dismiss" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { id?: unknown };
      const ok = await dismissNeed(String(b.id ?? ""));
      if (ok) needsChanged();
      return Response.json({ ok }, { status: ok ? 200 : 400 });
    }

    const goAnswer = path.match(/^\/api\/go\/([a-z0-9-]{6,40})$/);
    if (goAnswer && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { decision?: string };
      const res = await decideGo(goAnswer[1]!, b.decision === "go");
      needsChanged();
      return Response.json(res, { status: res.ok ? 200 : 409 });
    }

    const orderAction = path.match(/^\/api\/orders\/(\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,63})\/(go|cancel|retry)$/);
    if (orderAction && req.method === "POST") {
      const [, slug, action] = orderAction as unknown as [string, string, string];
      const res = action === "go" ? await approveOrder(slug) : action === "retry" ? await retryOrder(slug) : await cancelOrder(slug);
      if (res.ok) {
        await kickNodeOrders();
        sseBroadcast("ship", "fleet");
        needsChanged();
      }
      return Response.json(res, { status: res.ok ? 200 : 400 });
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
      if (result.ok) {
        sseBroadcast("agents");
        needsChanged();
      }
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

    // Voice (lib/voice.ts): local Kokoro speech, OpenRouter transcription.
    if (path === "/api/voice/status" && req.method === "GET") {
      return Response.json({ tts: ttsState(), stt: await sttAvailable() });
    }
    if (path === "/api/voice/stt" && req.method === "POST") {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length < 1000 || buf.length > 12_000_000) return Response.json({ ok: false, message: "Recording too short or too long." }, { status: 400 });
      try {
        const r = await transcribe(buf);
        return Response.json({ ok: true, text: r.text, cost: r.cost });
      } catch (e) {
        return Response.json({ ok: false, message: e instanceof Error ? e.message : "transcription failed" }, { status: 502 });
      }
    }
    if (path === "/api/voice/tts" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { agent?: string; text?: string; part?: number };
      const agentId = String(b.agent ?? "");
      const parts = speechParts(speakable(String(b.text ?? "")));
      const part = Math.max(0, Math.floor(Number(b.part) || 0));
      if (!parts.length || part >= parts.length) return new Response(null, { status: 204, headers: { "X-Parts": String(parts.length) } });
      const meta = (await loadAgents()).find((a) => a.id === agentId);
      const voice = voiceFor(agentId, meta?.role, meta?.voice);
      try {
        const wav = await synthesize(parts[part]!, voice);
        return new Response(wav, { headers: { "Content-Type": "audio/wav", "X-Parts": String(parts.length), "X-Voice": voice, "Cache-Control": "no-store" } });
      } catch (e) {
        return Response.json({ ok: false, message: e instanceof Error ? e.message : "speech failed" }, { status: 503 });
      }
    }

    // The crew API (extensions/crew.ts) is served by the fleet node, where crewmates run.

    // Shipyard: register, crew, budget, orchestrator, voyages (lib/shipyard.ts).
    if (path === "/api/ships" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const res = await registerShip({
        id: String(b.id ?? "").trim(),
        path: String(b.path ?? "").trim(),
        mode: String(b.mode ?? ""),
        factory: b.factory === true || b.factory === "on",
        firstmate: String(b.firstmate ?? ""),
      });
      if (res.ok) sseBroadcast("ship", String(b.id));
      return Response.json(res, { status: res.ok ? 200 : 400 });
    }

    const shipAction = path.match(/^\/api\/ships\/([a-z][a-z0-9_-]{0,40})\/(crew|orchestrator|voyage|dock)$/);
    if (shipAction && req.method === "POST") {
      const [, shipId, action] = shipAction as unknown as [string, string, string];
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      let res: { ok: boolean; message: string };
      const ashore = action === "crew" && b.remove ? `${shipId}-${String(b.remove)}` : "";
      if (ashore && hostRunning(ashore)) {
        // Off the rail it could no longer be watched or stopped; finish or stop the turn first.
        res = { ok: false, message: `${ashore} is mid-task. Stop it or let it finish, then send it ashore.` };
      } else if (action === "crew") {
        if (ashore) await stopHost(ashore);
        const role = String(b.role ?? "");
        res = await setCrew(shipId, {
          ...(b.add ? { add: String(b.add) } : {}),
          ...(b.remove ? { remove: String(b.remove) } : {}),
          ...("budget" in b ? { budget: { role, usd: b.budget === "" || b.budget === null ? null : Number(b.budget) } } : {}),
          ...("model" in b ? { model: { role, model: b.model === null ? null : String(b.model) } } : {}),
        });
        if (res.ok) {
          await refreshAgentTargets();
          await refreshNodeTargets();
          sseBroadcast("rail");
        }
      } else if (action === "orchestrator") {
        res = await setOrchestrator(shipId, String(b.orchestrator ?? ""));
      } else if (action === "voyage") {
        const ship = await findShip(shipId);
        const to = String(b.to ?? "");
        const allowed = ship ? (ship.orchestrator === "firstmate" ? ["firstmate"] : []).concat(ship.crew.map((r) => `${shipId}-${r}`)) : [];
        if (!allowed.includes(to)) {
          res = { ok: false, message: "Send the voyage to Firstmate or a crewmate aboard." };
        } else {
          const started = await startVoyage(shipId, String(b.goal ?? ""), to);
          res = started;
          if (started.ok && started.voyage && ship) {
            const line = await appendCaptainChat(to, voyageBrief(ship, started.voyage));
            broadcastChat(to, line);
            await handToNode(to, line);
          }
        }
      } else {
        res = await dockVoyage(shipId, String(b.summary ?? ""));
      }
      sseBroadcast("ship", shipId);
      return Response.json(res, { status: res.ok ? 200 : 400 });
    }

    if (path === "/partials/harbor" && req.method === "GET") {
      return new Response(await harborHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const shipPartial = path.match(/^\/partials\/ship\/([a-z][a-z0-9_-]{0,63})$/);
    if (shipPartial && req.method === "GET") {
      const html = await shipDeckHtml(shipPartial[1]!);
      return html === null
        ? new Response(`<p class="warn">No ship named ${shipPartial[1]}.</p>`, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } })
        : new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      let body: { text?: string; requestId?: string };
      try {
        body = (await req.json()) as { text?: string; requestId?: string };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      try {
        const { line, duplicate } = await captainSend(agentId, body.text ?? "", body.requestId);
        return Response.json({ ok: true, line, ...(duplicate ? { duplicate: true } : {}) });
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

    // Section routes (/needs, /health, /fleet, /agents) are the same page; app.js reads the path.
    if (path === "/" || path === "/index.html" || /^\/(harbor|health|fleet|agents|needs)\/?$/.test(path) || /^\/ships\/[a-z][a-z0-9_-]{0,63}\/?$/.test(path)) {
      const html = await readFile(join(publicDir, "index.html"), "utf8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const filePath = join(publicDir, path.replace(/^\//, ""));
    const file = Bun.file(filePath);
    if (await file.exists()) {
      // Vendored libraries carry their version in the file name: cache them for good.
      return path.startsWith("/vendor/")
        ? new Response(file, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } })
        : new Response(file);
    }

    return new Response("not found", { status: 404 });
}

console.error(`dashboard http://${HOST}:${PORT} (repo ${ROOT})`);

export default server;
