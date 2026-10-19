import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { statSync } from "node:fs";
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
  appendChatLine,
  appendChatError,
  findSentLine,
  readCaptainChat,
  type ChatLine,
} from "./lib/chat.ts";
import { metricsStripHtml } from "./lib/bus.ts";
import { collectCaptainHolds, fleetStripHtml, lastFleetSnapshot } from "./lib/fleet-snapshot.ts";
import { collectNeedsYou, dismissNeed } from "./lib/needs-you.ts";
import { toolFailuresHtml } from "./lib/tool-failures.ts";
import { routinesHtml } from "./lib/routines.ts";
import { LiveSession } from "./lib/live-voice.ts";
import { vaultDoctorHtml } from "./lib/vault-doctor.ts";
import { toolGateHtml } from "./lib/tool-gate.ts";
import { jevHtml } from "./lib/compaction-advisor.ts";
import { jevSpend } from "./lib/jev.ts";
import { escapeHtml } from "./lib/quota.ts";
import { describeGates, runGates } from "./lib/gates.ts";
import { addSubscription, pushNewNeeds, removeSubscription, sendToAll, subscriptions, validSub, vapidKeys } from "./lib/push.ts";
import { ackNotice, notifyCaptain, quietState, snooze, wake } from "./lib/notify.ts";
import { approveOrder, cancelOrder, checkOrderBody, createOrder, deleteOrder, editOrder, retryOrder } from "./lib/order-note.ts";
import { answerCaptainHold } from "./lib/hold-answer.ts";
import { deleteGroup, readGroups, saveGroup, type GroupInput } from "./lib/groups.ts";
import { groupAdwSectionHtml, groupsPanelHtml } from "./lib/group-partials.ts";
import { resolveRoute } from "./lib/route.ts";
import { loadAgents } from "./lib/agents.ts";
import { speakable, speechParts, sttAvailable, synthesize, transcribe, ttsState, voiceFor } from "./lib/voice.ts";
import { onShipLogWrite } from "./lib/ship-log.ts";
import { harborHtml, shipDeckHtml } from "./lib/ship-view.ts";
import { metricsDashboardHtml, parsePeriod } from "./lib/metrics-view.ts";
import { dockVoyage, findShip, openVoyage, registerShip, setCrew, setOrchestrator, startVoyage, voyageBrief } from "./lib/shipyard.ts";
import { applyProposal, dismissProposal, hasHelmsman, helmDigest } from "./lib/helm.ts";
import { ledgerMarkdown, voyageId, voyageLedger } from "./lib/metrics.ts";
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
  decideGate,
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

type WsData = { agentId: string; live?: LiveSession };
const chatSockets = new Map<string, Set<ServerWebSocket<WsData>>>();
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
    ...(line.requestId ? { requestId: line.requestId } : {}),
    ...(line.step ? { step: true } : {}),
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

/** Live voice sessions talking to Alice: her chat replies are relayed to them (conversation mode V3). */
const liveSessions = new Set<LiveSession>();

function broadcastChat(agentId: string, line: ChatLine) {
  needsChanged();
  if (agentId === "alice" && line.from === "alice" && line.kind === "chat" && !line.step && line.text.trim()) for (const s of liveSessions) s.relay(line.text);
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
    void pushNeeds();
  }, 300);
}
// Phone push (D6): anything new in Needs you goes to every subscribed device.
let pushing = false;
async function pushNeeds() {
  if (pushing) return;
  pushing = true;
  try {
    await pushNewNeeds(await collectNeedsYou({ waiting: hostWaiting, holds: currentHolds() }));
  } catch (e) {
    void dashLog("push", `needs push failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pushing = false;
  }
}
// A safety net for changes that arrive without a signal (notices written by the node).
setInterval(() => void pushNeeds(), 20_000);
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

const server = Bun.serve<WsData>({
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
      const data = ws.data;
      if (data.agentId === "voice") {
        // Conversation mode (lib/live-voice.ts): this socket bridges to one Gemini Live session.
        data.live = new LiveSession(
          { audio: (pcm) => ws.send(pcm), event: (e) => ws.send(JSON.stringify(e)), close: () => ws.close() },
          {
            agent: "alice",
            // V3: hand-offs to the full Alice, what needs the captain, and the Go (behind lib/live-voice.ts's policy door).
            actions: {
              sendToAlice: async (text) => void (await captainSend("alice", text)),
              needsYou: async () =>
                (await collectNeedsYou({ waiting: hostWaiting, holds: currentHolds() })).map((i) => ({
                  id: i.id,
                  kind: i.kind,
                  ...(i.kind === "go" ? { goId: i.goId } : {}),
                  summary: "summary" in i ? String(i.summary) : "what" in i ? String(i.what) : "title" in i ? String(i.title) : i.kind,
                })),
              decideGo: async (goId, go) => {
                const r = await decideGo(goId, go);
                needsChanged();
                return r;
              },
            },
          },
        );
        liveSessions.add(data.live);
        void data.live.start();
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
      const data = ws.data;
      if (data.live) {
        if (typeof message === "string") data.live.control(message);
        else data.live.audio(new Uint8Array(message));
        return;
      }
      const { text, requestId } = parseWsSend(message.toString());
      captainSend(data.agentId, text, requestId)
        .catch(() => {
          ws.send(JSON.stringify({ error: "send failed" }));
        });
    },
    close(ws) {
      const data = ws.data;
      if (data.live) liveSessions.delete(data.live);
      data.live?.close();
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
/** Send the ship's helmsman a Helm review (after a dock, or when the captain asks). */
async function sendHelmReview(shipId: string, reason: string, ledger = ""): Promise<{ ok: boolean; message: string }> {
  const ship = await findShip(shipId);
  if (!ship || !hasHelmsman(ship)) return { ok: false, message: `${shipId} has no helmsman aboard. Bring one aboard in the shipyard.` };
  const to = `${shipId}-helmsman`;
  const line = await appendChatLine(to, { ts: new Date().toISOString(), from: "helm", kind: "crew", text: helmDigest(ship, reason, ledger).slice(0, 8000) });
  broadcastChat(to, line);
  await handToNode(to, line);
  return { ok: true, message: `Helm review sent to ${to}. Proposals appear on the deck.` };
}

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

    // Phone push (lib/push.ts): the page subscribes a device with the VAPID public key.
    if (path === "/api/push/key" && req.method === "GET") {
      return Response.json({ publicKey: vapidKeys().publicKey, devices: subscriptions().length });
    }
    if (path === "/api/push/subscribe" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { sub?: unknown; label?: string };
      if (!validSub(b.sub)) return Response.json({ ok: false, message: "Not a push subscription." }, { status: 400 });
      addSubscription(b.sub, String(b.label ?? ""));
      return Response.json({ ok: true, devices: subscriptions().length });
    }
    if (path === "/api/push/unsubscribe" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { endpoint?: string };
      return Response.json({ ok: removeSubscription(String(b.endpoint ?? "")), devices: subscriptions().length });
    }
    if (path === "/api/push/test" && req.method === "POST") {
      const r = await sendToAll({ title: "Fleet", body: "Notifications are on for this device, Captain.", tag: "test", url: "/needs" });
      return Response.json({ ok: r.sent > 0, ...r });
    }

    if (path === "/api/needs-you" && req.method === "GET") {
      return Response.json({ items: await collectNeedsYou({ waiting: hostWaiting, holds: currentHolds() }), build: pageBuild() });
    }

    // Quiet hours: Snooze holds interruptions; Wake ends it and compiles what was held into a digest.
    if (path === "/api/quiet" && req.method === "GET") {
      const { journalDb } = await import("./lib/journal.ts");
      const held = (journalDb().query("SELECT COUNT(*) AS n FROM notices WHERE delivery = 'held' AND digest IS NULL").get() as { n: number } | null)?.n ?? 0;
      return Response.json({ ...quietState(), held });
    }
    if (path === "/api/quiet" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { snooze?: boolean };
      if (b.snooze) snooze();
      else await wake();
      needsChanged();
      return Response.json({ ok: true, ...quietState() });
    }
    const noticeAck = path.match(/^\/api\/notices\/(\d+)\/ack$/);
    if (noticeAck && req.method === "POST") {
      const ok = ackNotice(Number(noticeAck[1]));
      needsChanged();
      return Response.json({ ok });
    }

    if (path === "/api/needs-you/dismiss" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { id?: unknown };
      const ok = await dismissNeed(String(b.id ?? ""));
      if (ok) needsChanged();
      return Response.json({ ok }, { status: ok ? 200 : 400 });
    }

    const gateAnswer = path.match(/^\/api\/gate\/(gate-[a-z0-9-]{6,40})$/);
    if (gateAnswer && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { decision?: string };
      const res = await decideGate(gateAnswer[1]!, b.decision === "allow");
      needsChanged();
      return Response.json(res, { status: res.ok ? 200 : 409 });
    }

    const goAnswer = path.match(/^\/api\/go\/([a-z0-9-]{6,40})$/);
    if (goAnswer && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { decision?: string };
      const res = await decideGo(goAnswer[1]!, b.decision === "go");
      needsChanged();
      return Response.json(res, { status: res.ok ? 200 : 409 });
    }

    // The captain's own orders, from the fleet deck: check, or submit (approved at once; they are the captain's).
    if ((path === "/api/orders" || path === "/api/orders/check") && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { title?: string; ship?: string; body?: string };
      const body = String(b.body ?? "");
      if (path === "/api/orders/check") return Response.json(checkOrderBody(body));
      const title = String(b.title ?? "").trim();
      const ship = String(b.ship ?? "fleet");
      if (title.length < 3) return Response.json({ ok: false, message: "Give the order a title." }, { status: 400 });
      const r = await createOrder({ title, ship, by: "captain", body, status: "approved" });
      if (r.errors.length) return Response.json({ ok: false, message: r.errors.join(" · ") }, { status: 400 });
      await kickNodeOrders();
      sseBroadcast("ship", "fleet");
      return Response.json({ ok: true, message: `Submitted ${r.slug}; Alice starts it when she is free.` });
    }

    const orderAction = path.match(/^\/api\/orders\/(\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,63})\/(go|cancel|retry|edit|delete)$/);
    if (orderAction && req.method === "POST") {
      const [, slug, action] = orderAction as unknown as [string, string, string];
      const b = action === "edit" ? ((await req.json().catch(() => ({}))) as { title?: string; body?: string }) : {};
      const res =
        action === "go" ? await approveOrder(slug)
        : action === "retry" ? await retryOrder(slug)
        : action === "edit" ? await editOrder(slug, String(b.title ?? ""), String(b.body ?? ""))
        : action === "delete" ? await deleteOrder(slug)
        : await cancelOrder(slug);
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

    if (path === "/partials/jev" && req.method === "GET") {
      return new Response(jevHtml(escapeHtml, jevSpend(7)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/partials/tool-gate" && req.method === "GET") {
      return new Response(toolGateHtml(escapeHtml), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/partials/routines" && req.method === "GET") {
      return new Response(routinesHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/partials/vault-doctor" && req.method === "GET") {
      return new Response(vaultDoctorHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/partials/tool-failures" && req.method === "GET") {
      return new Response(toolFailuresHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (path === "/partials/fleet-metrics" && req.method === "GET") {
      return new Response(metricsDashboardHtml(parsePeriod(url.searchParams.get("days"))), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
        return new Response(new Uint8Array(wav), { headers: { "Content-Type": "audio/wav", "X-Parts": String(parts.length), "X-Voice": voice, "Cache-Control": "no-store" } });
      } catch (e) {
        // The page falls back to the browser's own (robotic) voice on a 503: log why.
        void dashLog("voice", `tts failed for ${agentId} (${voice}): ${e instanceof Error ? e.message : String(e)}`);
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
        template: String(b.template ?? ""),
      });
      if (res.ok) sseBroadcast("ship", String(b.id));
      return Response.json(res, { status: res.ok ? 200 : 400 });
    }

    // Run gates (lib/gates.ts): the dock gates (or task gates) that are not green, in the background;
    // the result arrives as a notice (done or blocked).
    const gatesRun = path.match(/^\/api\/ships\/([a-z][a-z0-9_-]{0,40})\/gates$/);
    if (gatesRun && req.method === "POST") {
      const ship = await findShip(gatesRun[1]!);
      const b = (await req.json().catch(() => ({}))) as { stage?: string };
      const stage = b.stage === "task" ? "task" : "dock";
      if (!ship || !ship.gates[stage].length) return Response.json({ ok: false, message: `${gatesRun[1]} has no ${stage} gates.` }, { status: 400 });
      void runGates(ship, stage, "captain").then(({ report, failures }) =>
        notifyCaptain({ from: "helm", kind: report.green ? "done" : "blocked", summary: `${ship.id}: ${describeGates(report)}`, detail: failures.slice(0, 3000), ref: ship.id }),
      );
      return Response.json({ ok: true, message: `Running ${ship.id}'s ${stage} gates (${ship.gates[stage].join(", ")}); you get a notice when they finish.` });
    }

    const helmAction = path.match(/^\/api\/ships\/([a-z][a-z0-9_-]{0,40})\/helm(?:\/([0-9a-f]{6})\/(apply|dismiss)|\/review)$/);
    if (helmAction && req.method === "POST") {
      const [, shipId, id, act] = helmAction as unknown as [string, string, string | undefined, string | undefined];
      const res = id ? (act === "apply" ? await applyProposal(shipId, id) : await dismissProposal(shipId, id)) : await sendHelmReview(shipId, "the captain asked for a review");
      sseBroadcast("ship", shipId);
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
        const sailing = await openVoyage(shipId);
        res = await dockVoyage(shipId, String(b.summary ?? ""));
        // After a dock, the helmsman (when aboard) reviews the ship's process with the voyage's ledger.
        if (res.ok && sailing) {
          const ship = await findShip(shipId);
          const ledger = voyageLedger(voyageId(sailing.file));
          if (ship && hasHelmsman(ship)) void sendHelmReview(shipId, `the voyage "${sailing.goal.slice(0, 160)}" docked`, ledger ? ledgerMarkdown(ledger) : "").catch((e) => console.error("[helm]", e));
        }
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
    if (path === "/" || path === "/index.html" || /^\/(harbor|health|fleet|agents|needs)\/?$/.test(path) || /^\/health\/(status|usage|metrics|diagnostics)\/?$/.test(path) || /^\/ships\/[a-z][a-z0-9_-]{0,63}\/?$/.test(path)) {
      const html = await readFile(join(publicDir, "index.html"), "utf8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    const filePath = join(publicDir, path.replace(/^\//, ""));
    const file = Bun.file(filePath);
    if (await file.exists()) {
      // Vendored libraries carry their version in the file name: cache them for good.
      // The page's own files change with every deploy: always revalidate.
      return path.startsWith("/vendor/")
        ? new Response(file, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } })
        : new Response(file, { headers: { "Cache-Control": "no-cache" } });
    }

    return new Response("not found", { status: 404 });
}

/** Which page code is on disk (the files' change times): an open tab compares it and reloads when it changes. */
function pageBuild(): string {
  let parts = "";
  for (const f of ["index.html", "app.js", "md.js", "live-voice.js", "pcm-capture.js", "pixel.css", "ui.css"]) {
    try {
      parts += statSync(join(publicDir, f)).mtimeMs.toFixed(0);
    } catch {
      /* missing file */
    }
  }
  return Bun.hash(parts).toString(36);
}

console.error(`dashboard http://${HOST}:${PORT} (repo ${ROOT})`);

export default server;
