import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeKey } from "./fleet-env.ts";
import { recordFreeCall } from "./free-models.ts";
import { fleetInboxRoot, ROOT } from "./paths.ts";

/**
 * Conversation mode V1 (vault task fleet-voice-modes, built toward
 * cuppibla/live-dj): the dashboard bridges one browser to one Gemini Live
 * session. The browser sends 16 kHz 16-bit mono PCM (binary frames) and JSON
 * ({type:"text"} or {type:"end"}); it receives the agent's 24 kHz PCM (binary)
 * and JSON events: ready, transcript (captain or agent), interrupted, turn,
 * error. Runs on the FREE Gemini account only (GEMINI_FREE_API_KEY): free-tier
 * audio may be used for training, so the talk stays non-sensitive. No fleet
 * tools yet (V2); transcripts go to <inbox>/<agent>/voice/<date>.jsonl, not
 * the agent's chat thread.
 */

export const LIVE_MODEL = process.env.FLEET_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";
export const LIVE_VOICE = process.env.FLEET_LIVE_VOICE ?? "Aoede";
const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** V2: what live Alice can look up while she talks (read-only; acting comes with V3 and the captain's Go). */
export const LIVE_TOOLS = [
  { name: "fleet_status", description: "The fleet right now: ships, open voyages and task progress, who is working, what waits on the captain, today's spend.", parameters: { type: "OBJECT", properties: { detail: { type: "BOOLEAN", description: "Add each crewmate's activity and spend per agent" } } } },
  { name: "ship", description: "One ship: its open voyage's tasks (owner, status) and its latest log lines.", parameters: { type: "OBJECT", properties: { ship: { type: "STRING", description: "Ship id, e.g. fleet, pochteca, kinwork" } }, required: ["ship"] } },
  { name: "vault_tasks", description: "The captain's vault tasks: by filter (ready, open, in-progress, blocked, done) or one task by id.", parameters: { type: "OBJECT", properties: { filter: { type: "STRING", description: "ready (default), open, in-progress, blocked, done" }, id: { type: "STRING", description: "One task's id" } } } },
];

/** V3: acting by voice. The dashboard supplies these; every call passes the policy door below. */
export type LiveActions = {
  /** Hand a message to the full Alice (her chat thread, as the captain's words); her reply is relayed later. */
  sendToAlice(text: string): Promise<void>;
  /** What waits on the captain (Go requests with their goId, questions, proposals). */
  needsYou(): Promise<{ id: string; kind: string; goId?: string; summary: string }[]>;
  decideGo(goId: string, go: boolean): Promise<{ ok: boolean; message: string }>;
};

export const ACTION_TOOLS = [
  { name: "ask_alice", description: "Hand a request to the full Alice in the chat, who can act on the fleet (set sail, dock, crew changes, orders) and asks the captain's Go for anything that changes things. Use it for any action or for work you cannot do by voice. Returns at once; her reply arrives later and you will be told to relay it.", parameters: { type: "OBJECT", properties: { message: { type: "STRING", description: "The request in the captain's words, complete enough for Alice to act on" } }, required: ["message"] } },
  { name: "needs_you", description: "What waits on the captain right now: Go requests (each with a go_id), questions, helm proposals, notices.", parameters: { type: "OBJECT", properties: {} } },
  { name: "decide_go", description: "Give or refuse the captain's Go on one pending Go request (go_id from needs_you). Only after the captain has just said go (or no) to that specific request in their own words; read it back first. The server checks the captain's last words and refuses otherwise.", parameters: { type: "OBJECT", properties: { go_id: { type: "STRING" }, decision: { type: "STRING", description: "go or no" } }, required: ["go_id", "decision"] } },
];

const AFFIRM = /\b(go|yes|yeah|yep|approve[ds]?|do it|go ahead|confirm(ed)?|proceed)\b/i;
const DENY = /\b(no|nope|don'?t|do not|deny|decline|cancel|stop|reject)\b/i;

/** The policy door for decide_go: the captain's own last words must say it (live-dj's before_tool_callback). */
export function goPolicy(decision: string, captainWords: string): string | null {
  const said = captainWords.trim();
  if (!said) return "The captain has not said anything yet; ask them to say go or no for this request.";
  if (decision === "go") return AFFIRM.test(said) && !DENY.test(said) ? null : `The captain's last words ("${said.slice(0, 120)}") are not a clear go; read the request back and ask them to say go.`;
  if (decision === "no") return DENY.test(said) ? null : `The captain's last words ("${said.slice(0, 120)}") are not a clear no; ask them.`;
  return "decision must be go or no.";
}

/** Run a live tool; compact text back to the model, a one-line summary for the drawer's action log. */
export async function runLiveTool(name: string, args: Record<string, unknown>): Promise<{ result: string; summary: string }> {
  const { fleetStatus, shipLog, shipTasks } = await import("./fleet-api.ts");
  const { vaultTasksReport, VAULT_FILTERS } = await import("./vault-tasks.ts");
  const { toolText, VIEWS } = await import("./tool-out.ts");
  if (name === "fleet_status") return { result: toolText(await fleetStatus(Boolean(args.detail)), VIEWS.fleet_status).slice(0, 6000), summary: "checked the fleet's status" };
  if (name === "ship") {
    const id = String(args.ship ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return { result: `${toolText(await shipTasks(id), VIEWS.ship_tasks)}\n${toolText(shipLog(id, 12), VIEWS.ship_log)}`.slice(0, 6000), summary: `looked at ${id}` };
  }
  if (name === "vault_tasks") {
    const filter = VAULT_FILTERS.includes(String(args.filter) as never) ? String(args.filter) : "ready";
    return { result: toolText(vaultTasksReport(filter as never, args.id ? String(args.id) : ""), VIEWS.vault_tasks).slice(0, 6000), summary: args.id ? `read vault task ${String(args.id)}` : `listed ${filter} vault tasks` };
  }
  return { result: `No tool named ${name}.`, summary: `tried an unknown tool ${name}` };
}

export type LiveSink = { audio(pcm: Uint8Array): void; event(e: Record<string, unknown>): void; close(): void };
/** The upstream socket: a WebSocket, or a fake in tests. */
export type Upstream = { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number; reason: string }) => void) | null; onerror: (() => void) | null };

/** The agent's character (agents/<id>/character.md), or "" when it has none. */
export function characterFor(agent: string, root = ROOT): string {
  const f = join(root, "agents", agent, "character.md");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

/** The agent's Gemini Live voice (`live_voice:` in agents/<id>/agent.yaml), else the default. */
export function liveVoiceFor(agent: string, root = ROOT): string {
  try {
    const m = readFileSync(join(root, "agents", agent, "agent.yaml"), "utf8").match(/^live_voice:\s*([A-Za-z]+)\s*$/m);
    return m ? m[1]! : LIVE_VOICE;
  } catch {
    return LIVE_VOICE;
  }
}

/** A read-only snapshot of the fleet for the start of a talk: what Alice knows without tools (V2 adds tools). */
export async function fleetBriefing(): Promise<string> {
  const { fleetStatus } = await import("./fleet-api.ts");
  const { vaultTasksReport } = await import("./vault-tasks.ts");
  const s = (await fleetStatus(true)) as Record<string, unknown>;
  const ready = vaultTasksReport("ready") as { tasks?: { id: string; title: string; priority: string }[] };
  const lines: string[] = [`As of ${new Date().toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" })}: ${String(s.message ?? "")}`];
  for (const sh of (s.ships as Record<string, unknown>[] | string[] | undefined) ?? []) lines.push(`- ${typeof sh === "string" ? sh : JSON.stringify(sh).slice(0, 300)}`);
  const needs = (s.needsCaptain as unknown[] | undefined) ?? [];
  if (needs.length) lines.push(`Waiting on the captain: ${needs.map((n) => (typeof n === "string" ? n : JSON.stringify(n))).join("; ").slice(0, 600)}`);
  if (typeof s.spendTodayUsd === "number") lines.push(`Spend today: $${s.spendTodayUsd.toFixed(2)}.`);
  if (ready.tasks?.length) lines.push(`Ready vault tasks: ${ready.tasks.slice(0, 6).map((t) => `${t.title} (${t.priority})`).join("; ")}.`);
  return lines.join("\n").slice(0, 3500);
}

/** Who the captain is talking to, by voice: character, how to talk, and what the fleet looks like now. */
export function persona(agent: string, character = "", briefing = ""): string {
  const who = agent === "alice" ? "Alice, the fleet's omni agent" : agent;
  return [
    `You are ${who}, speaking with the captain by voice in the fleet dashboard.`,
    character ? `Your character:\n${character}` : "",
    "The fleet is the captain's set of AI agents: officers (Alice, the Architect, the Designer) and ship crews (a lead, a builder, a scout, a designer, a helmsman) that sail voyages on the captain's projects.",
    "Speak naturally and briefly: one to three sentences, then let the captain talk. The captain can interrupt you; when they do, stop and listen.",
    briefing ? `What you know about the fleet right now (a snapshot from when this talk began; it does not update):\n${briefing}` : "",
    "For fresh detail, use your tools (fleet_status, ship, vault_tasks) rather than guessing; say briefly that you are checking. To act on the fleet, hand it to the full Alice with ask_alice (she asks the captain's Go); tell the captain you have passed it on. For a pending Go, read the request back (needs_you), wait for the captain to say go or no, then call decide_go. Never invent fleet facts.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class LiveSession {
  private up: Upstream | null = null;
  private ready = false;
  private queued: string[] = [];
  private captainText = "";
  private agentText = "";
  private tokens = { in: 0, out: 0 };
  private started = Date.now();
  private closed = false;
  private actions: string[] = [];
  private prevCaptainText = "";

  constructor(
    private sink: LiveSink,
    private opts: { agent: string; connect?: (url: string) => Upstream; key?: () => Promise<string>; briefing?: () => Promise<string>; character?: string; voice?: string; tool?: typeof runLiveTool; actions?: LiveActions },
  ) {}

  async start(): Promise<void> {
    const key = await (this.opts.key ?? (() => nodeKey("GEMINI_FREE_API_KEY")))();
    if (!key) {
      this.sink.event({ type: "error", message: "No free Gemini key (GEMINI_FREE_API_KEY in the service account); conversation mode is off." });
      this.sink.close();
      return;
    }
    const briefing = await (this.opts.briefing ?? fleetBriefing)().catch(() => "");
    const instruction = persona(this.opts.agent, this.opts.character ?? characterFor(this.opts.agent), briefing);
    const voice = this.opts.voice ?? liveVoiceFor(this.opts.agent);
    const up = (this.opts.connect ?? ((url) => new WebSocket(url) as unknown as Upstream))(`${LIVE_URL}?key=${key}`);
    this.up = up;
    up.onopen = () =>
      up.send(
        JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
            systemInstruction: { parts: [{ text: instruction }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{ functionDeclarations: this.opts.actions ? [...LIVE_TOOLS, ...ACTION_TOOLS] : LIVE_TOOLS }],
          },
        }),
      );
    up.onmessage = (e) => void this.fromUpstream(e.data);
    up.onerror = () => this.sink.event({ type: "error", message: "The voice service connection failed." });
    up.onclose = (e) => {
      if (!this.closed) this.sink.event({ type: "error", message: `The voice session ended${e.reason ? `: ${String(e.reason).slice(0, 160)}` : ""}.` });
      this.finish();
    };
  }

  /** 16 kHz PCM from the browser's microphone. */
  audio(pcm: Uint8Array): void {
    this.send({ realtimeInput: { audio: { data: Buffer.from(pcm).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
  }

  /** A JSON message from the browser. */
  control(raw: string): void {
    let m: { type?: string; text?: string } = {};
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "text" && m.text?.trim()) this.send({ realtimeInput: { text: m.text.trim().slice(0, 2000) } });
    if (m.type === "end") this.close();
  }

  close(): void {
    this.closed = true;
    try {
      this.up?.close();
    } catch {
      /* already closed */
    }
    this.finish();
  }

  private send(msg: unknown): void {
    const s = JSON.stringify(msg);
    if (this.ready && this.up) this.up.send(s);
    else if (this.queued.length < 50) this.queued.push(s); // the first words before setup completes
  }

  private async fromUpstream(data: unknown): Promise<void> {
    const raw = typeof data === "string" ? data : data instanceof Blob ? await data.text() : Buffer.from(data as ArrayBuffer).toString("utf8");
    let m: Record<string, any>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.setupComplete) {
      this.ready = true;
      for (const s of this.queued.splice(0)) this.up?.send(s);
      this.sink.event({ type: "ready", model: LIVE_MODEL });
    }
    const sc = m.serverContent;
    if (sc) {
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) this.sink.audio(new Uint8Array(Buffer.from(p.inlineData.data, "base64")));
      if (sc.inputTranscription?.text) {
        this.captainText += sc.inputTranscription.text;
        this.sink.event({ type: "transcript", role: "captain", text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription?.text) {
        this.agentText += sc.outputTranscription.text;
        this.sink.event({ type: "transcript", role: "agent", text: sc.outputTranscription.text });
      }
      if (sc.interrupted) this.sink.event({ type: "interrupted" });
      if (sc.turnComplete) {
        this.logTurn();
        this.sink.event({ type: "turn" });
      }
    }
    if (m.toolCall?.functionCalls?.length) await this.toolCall(m.toolCall.functionCalls);
    if (m.usageMetadata) {
      this.tokens.in = Number(m.usageMetadata.promptTokenCount) || this.tokens.in;
      this.tokens.out = Number(m.usageMetadata.responseTokenCount ?? m.usageMetadata.candidatesTokenCount) || this.tokens.out;
    }
    if (m.goAway) this.sink.event({ type: "error", message: "The voice service is ending this session soon; start a new conversation." });
  }

  /** Gemini asked for fleet facts: look them up, show each in the drawer's action log, and answer. */
  private async toolCall(calls: { id: string; name: string; args?: Record<string, unknown> }[]): Promise<void> {
    const responses = [];
    for (const c of calls) {
      const t0 = Date.now();
      let out: { result: string; summary: string; verdict?: "allowed" | "blocked" };
      try {
        out = ACTION_TOOLS.some((t) => t.name === c.name) ? await this.action(c.name, c.args ?? {}) : await (this.opts.tool ?? runLiveTool)(c.name, c.args ?? {});
      } catch (e) {
        out = { result: `The lookup failed: ${e instanceof Error ? e.message : String(e)}`, summary: `${c.name} failed` };
      }
      this.sink.event({ type: "action", name: c.name, summary: out.summary, ms: Date.now() - t0, ...(out.verdict ? { verdict: out.verdict } : {}) });
      this.actions.push(out.summary);
      responses.push({ id: c.id, name: c.name, response: { result: out.result } });
    }
    this.up?.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }

  /** V3 actions: hand-offs to the full Alice, what needs the captain, and the Go behind the policy door. */
  private async action(name: string, args: Record<string, unknown>): Promise<{ result: string; summary: string; verdict?: "allowed" | "blocked" }> {
    const a = this.opts.actions;
    if (!a) return { result: "Acting by voice is not available in this session.", summary: `${name} unavailable`, verdict: "blocked" };
    if (name === "ask_alice") {
      const message = String(args.message ?? "").trim().slice(0, 2000);
      if (!message) return { result: "Say what to ask Alice.", summary: "ask_alice with no message", verdict: "blocked" };
      await a.sendToAlice(`(by voice) ${message}`);
      return { result: "Sent to Alice in the chat. Tell the captain briefly; you will be given her reply to relay when it comes.", summary: `asked Alice: ${message.slice(0, 80)}`, verdict: "allowed" };
    }
    if (name === "needs_you") {
      const items = await a.needsYou();
      return { result: items.length ? items.map((i) => `${i.kind}${i.goId ? ` go_id=${i.goId}` : ""}: ${i.summary}`).join("\n").slice(0, 4000) : "Nothing waits on the captain.", summary: `checked Needs you (${items.length})` };
    }
    const goId = String(args.go_id ?? "");
    const decision = String(args.decision ?? "").toLowerCase();
    const refusal = goPolicy(decision, this.lastCaptainWords());
    if (refusal) return { result: `Not done: ${refusal}`, summary: `decide_go ${decision} held by the policy door`, verdict: "blocked" };
    const pending = (await a.needsYou()).find((i) => i.goId === goId);
    if (!pending) return { result: `No pending Go with go_id ${goId}; check needs_you.`, summary: "decide_go: unknown request", verdict: "blocked" };
    const r = await a.decideGo(goId, decision === "go");
    return { result: r.message, summary: `${decision === "go" ? "gave the Go" : "refused"}: ${pending.summary.slice(0, 80)}`, verdict: r.ok ? "allowed" : "blocked" };
  }

  /** What the captain said this turn, else last turn. */
  private lastCaptainWords(): string {
    return this.captainText.trim() || this.prevCaptainText;
  }

  /** The full Alice replied in the chat: have the live voice tell the captain. */
  relay(text: string): void {
    this.send({ realtimeInput: { text: `[Alice's reply in the chat just arrived. Tell the captain, briefly and in your own words: ${text.slice(0, 1500)}]` } });
    this.sink.event({ type: "action", name: "relay", summary: "Alice replied in the chat", ms: 0 });
  }

  /** One spoken exchange, appended to the agent's voice log (not its chat thread). */
  private logTurn(): void {
    if (!this.captainText.trim() && !this.agentText.trim()) return;
    try {
      const dir = join(fleetInboxRoot(), this.opts.agent, "voice");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), captain: this.captainText.trim(), agent: this.agentText.trim(), ...(this.actions.length ? { looked_up: this.actions.splice(0) } : {}), model: LIVE_MODEL })}\n`);
    } catch {
      /* the log never breaks the talk */
    }
    if (this.captainText.trim()) this.prevCaptainText = this.captainText.trim();
    this.captainText = "";
    this.agentText = "";
  }

  private finish(): void {
    if (this.up === null && this.closed) return;
    this.logTurn();
    if (this.up) recordFreeCall({ provider: "google", model: LIVE_MODEL, purpose: `voice:${this.opts.agent}`, ok: this.ready, ms: Date.now() - this.started, account: "gemini-free", tokensIn: this.tokens.in, tokensOut: this.tokens.out });
    this.up = null;
    this.sink.close();
  }
}
