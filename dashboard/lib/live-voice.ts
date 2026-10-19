import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { nodeKey } from "./fleet-env.ts";
import { recordFreeCall } from "./free-models.ts";
import { fleetInboxRoot } from "./paths.ts";

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

export type LiveSink = { audio(pcm: Uint8Array): void; event(e: Record<string, unknown>): void; close(): void };
/** The upstream socket: a WebSocket, or a fake in tests. */
export type Upstream = { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number; reason: string }) => void) | null; onerror: (() => void) | null };

/** Who the captain is talking to, by voice. Short: voice replies are spoken. */
export function persona(agent: string): string {
  const who = agent === "alice" ? "Alice, the fleet's omni agent" : agent;
  return [
    `You are ${who}, speaking with the captain by voice in the fleet dashboard.`,
    "The fleet is the captain's set of AI agents: officers (Alice, the Architect, the Designer) and ship crews (a lead, a builder, a scout, a designer, a helmsman) that sail voyages on the captain's projects.",
    "Speak naturally and briefly: one to three sentences, then let the captain talk. The captain can interrupt you; when they do, stop and listen.",
    "In this voice mode you cannot see the fleet's live state or act on it yet. If the captain asks for status or an action, say so plainly and suggest typing it to Alice in the chat, where the full Alice can act. Never invent fleet facts.",
  ].join(" ");
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

  constructor(
    private sink: LiveSink,
    private opts: { agent: string; connect?: (url: string) => Upstream; key?: () => Promise<string> },
  ) {}

  async start(): Promise<void> {
    const key = await (this.opts.key ?? (() => nodeKey("GEMINI_FREE_API_KEY")))();
    if (!key) {
      this.sink.event({ type: "error", message: "No free Gemini key (GEMINI_FREE_API_KEY in the service account); conversation mode is off." });
      this.sink.close();
      return;
    }
    const up = (this.opts.connect ?? ((url) => new WebSocket(url) as unknown as Upstream))(`${LIVE_URL}?key=${key}`);
    this.up = up;
    up.onopen = () =>
      up.send(
        JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } } } },
            systemInstruction: { parts: [{ text: persona(this.opts.agent) }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
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
      this.sink.event({ type: "ready", model: LIVE_MODEL, voice: LIVE_VOICE });
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
    if (m.usageMetadata) {
      this.tokens.in = Number(m.usageMetadata.promptTokenCount) || this.tokens.in;
      this.tokens.out = Number(m.usageMetadata.responseTokenCount ?? m.usageMetadata.candidatesTokenCount) || this.tokens.out;
    }
    if (m.goAway) this.sink.event({ type: "error", message: "The voice service is ending this session soon; start a new conversation." });
  }

  /** One spoken exchange, appended to the agent's voice log (not its chat thread). */
  private logTurn(): void {
    if (!this.captainText.trim() && !this.agentText.trim()) return;
    try {
      const dir = join(fleetInboxRoot(), this.opts.agent, "voice");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), captain: this.captainText.trim(), agent: this.agentText.trim(), model: LIVE_MODEL })}\n`);
    } catch {
      /* the log never breaks the talk */
    }
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
