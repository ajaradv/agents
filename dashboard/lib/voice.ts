import { existsSync } from "node:fs";
import { join } from "node:path";
import { envKeyValue, loadFleetDotenv } from "./fleet-env.ts";
import { dashLog } from "./log.ts";
import { ROOT } from "./paths.ts";

/**
 * Voice for the chat drawer.
 *
 * Speaking: local Kokoro-82M (dashboard/voice/kokoro_tts.py), one long-lived
 * process started on first use and stopped after 10 idle minutes. Kokoro only
 * reads, so a reply that contains a question is spoken, never answered (the
 * audio chat models tried first sometimes answered the text instead).
 *
 * Listening: the browser records 16 kHz mono WAV; Gemini Flash-Lite on
 * OpenRouter transcribes it (~$0.0001 a clip).
 */

const MODEL_DIR = join(ROOT, "fleet", "home", "models", "kokoro");
const HELPER = join(ROOT, "dashboard", "voice", "kokoro_tts.py");
const IDLE_MS = 10 * 60_000;
const STT_MODEL = "google/gemini-3.1-flash-lite";

// ---------------------------------------------------------------- voices

/** Kokoro voice per role, matched to the portraits; agent.yaml `voice:` overrides. */
const ROLE_VOICES: Record<string, string> = {
  firstmate: "am_michael",
  alice: "bf_emma", // young, polite, British
  architect: "bm_george",
  shipwright: "am_adam",
  designer: "af_heart",
  lead: "bm_fable",
  scout: "am_puck",
};
const POOL = ["am_eric", "bf_emma", "am_liam", "af_nova", "bm_lewis", "af_sarah", "am_onyx", "bf_isabella", "bm_daniel", "af_river"];

export function voiceFor(id: string, role?: string, override?: string): string {
  if (override && /^[ab][fm]_[a-z]+$/.test(override)) return override;
  if (role && ROLE_VOICES[role]) return ROLE_VOICES[role]!;
  if (ROLE_VOICES[id]) return ROLE_VOICES[id]!;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return POOL[(h >>> 0) % POOL.length]!;
}

/**
 * Chat text → what is worth saying aloud: code blocks and tables are left out,
 * Markdown punctuation dropped, links and long paths shortened.
 */
/** Split speakable text into parts of whole sentences, short enough to start playing fast. */
export function speechParts(text: string, first = 160, rest = 420): string[] {
  // Split only where sentence punctuation meets a space, so "desktop.png" stays whole.
  const sentences = text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const parts: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const limit = parts.length === 0 ? first : rest;
    if (cur && (cur + " " + s).length > limit) {
      parts.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) parts.push(cur);
  return parts;
}

export function speakable(text: string, max = 1800): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " (code on screen) ")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?:~|\.{0,2})?\/(?:[\w.@-]+\/){2,}([\w.@-]+)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>#]+/g, "")
    .replace(/\s*\n\s*\n\s*/g, ". ")
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .trim();
  if (s.length > max) {
    const cut = s.lastIndexOf(". ", max);
    s = s.slice(0, cut > max / 2 ? cut + 1 : max) + " The rest is on screen.";
  }
  return s;
}

// ---------------------------------------------------------------- speaking (Kokoro)

type Pending = { resolve: (wav: Uint8Array) => void; reject: (e: Error) => void };

let helper: {
  proc: ReturnType<typeof Bun.spawn>;
  ready: Promise<void>;
  pending: Map<string, Pending>;
  nextId: number;
  idle: ReturnType<typeof setTimeout> | null;
} | null = null;

export function ttsAvailable(): boolean {
  return existsSync(join(MODEL_DIR, "kokoro-v1.0.int8.onnx")) && existsSync(join(MODEL_DIR, "voices-v1.0.bin"));
}

export function ttsState(): "missing" | "cold" | "warm" {
  return !ttsAvailable() ? "missing" : helper ? "warm" : "cold";
}

function stopHelper(): void {
  if (!helper) return;
  for (const p of helper.pending.values()) p.reject(new Error("speech helper stopped"));
  try {
    helper.proc.kill("SIGTERM");
  } catch {
    /* gone */
  }
  helper = null;
}

function startHelper(): NonNullable<typeof helper> {
  const proc = Bun.spawn(["uv", "run", "-q", "--python", "3.12", "--with", "kokoro-onnx", "--with", "soundfile", "python", "-I", HELPER, MODEL_DIR], {
    cwd: join(ROOT, "dashboard", "voice"),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map<string, Pending>();
  let markReady: () => void = () => {};
  let markFailed: (e: Error) => void = () => {};
  const ready = new Promise<void>((res, rej) => {
    markReady = res;
    markFailed = rej;
  });
  const h = { proc, ready, pending, nextId: 1, idle: null as ReturnType<typeof setTimeout> | null };
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const j = JSON.parse(line) as { ready?: boolean; id?: string; ok?: boolean; wav?: string; error?: string };
          if (j.ready) markReady();
          else if (j.id && pending.has(j.id)) {
            const p = pending.get(j.id)!;
            pending.delete(j.id);
            if (j.ok && j.wav) p.resolve(Uint8Array.from(Buffer.from(j.wav, "base64")));
            else p.reject(new Error(j.error ?? "speech failed"));
          }
        } catch {
          /* not ours */
        }
      }
    }
  })();
  void proc.exited.then((code) => {
    markFailed(new Error(`speech helper exited (${code})`));
    if (helper?.proc === proc) {
      for (const p of pending.values()) p.reject(new Error("speech helper exited"));
      helper = null;
    }
    void dashLog("voice", `kokoro helper exited code=${code}`);
  });
  void dashLog("voice", `kokoro helper start pid=${proc.pid}`);
  return h;
}

export async function synthesize(text: string, voice: string, speed = 1.0): Promise<Uint8Array> {
  if (!ttsAvailable()) throw new Error("Local voice is not set up. Run bin/voice-setup.");
  if (!helper) helper = startHelper();
  const h = helper;
  if (h.idle) clearTimeout(h.idle);
  h.idle = setTimeout(stopHelper, IDLE_MS);
  await Promise.race([h.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("speech helper did not start")), 60_000))]);
  const id = String(h.nextId++);
  const out = new Promise<Uint8Array>((resolve, reject) => {
    h.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (h.pending.delete(id)) reject(new Error("speech timed out"));
    }, 60_000);
  });
  const stdin = h.proc.stdin as import("bun").FileSink;
  stdin.write(JSON.stringify({ id, text, voice, speed }) + "\n");
  stdin.flush();
  return out;
}

// ---------------------------------------------------------------- listening (OpenRouter)

// fleet/home/.env is a pipe fed by the secrets manager: a read can come back
// empty when the feed is slow, so keep the key once it has been read.
let openRouterKey = "";

async function routerKey(): Promise<string> {
  if (!openRouterKey) openRouterKey = envKeyValue("OPENROUTER_API_KEY", await loadFleetDotenv());
  return openRouterKey;
}

export async function sttAvailable(): Promise<boolean> {
  return Boolean(await routerKey());
}

/** Words a transcript should spell the fleet's way. */
const VOCAB = "Kinwork, Pochteca, lineage atria, Firstmate, Alice, Architect, Shipwright, Designer, crewmate, scout, lead, canvas, voyage, maneuver, harbor, shipyard, ADW, SSSF, impeccable, GSAP";

const NO_SPEECH = "[no speech]";
const HINTS = new Set(VOCAB.toLowerCase().split(/,\s*/));

/** True for "[no speech]" or a transcript made of the spelling hints (models recite them on silence). */
export function echoedHints(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.includes(NO_SPEECH)) return true;
  const items = t.replace(/[.!?]+$/, "").split(/,\s*/).filter(Boolean);
  return items.length >= 3 && items.filter((x) => HINTS.has(x)).length / items.length >= 0.6;
}

export async function transcribe(wav: Uint8Array): Promise<{ text: string; cost: number }> {
  const key = await routerKey();
  if (!key) throw new Error("Voice input needs OPENROUTER_API_KEY in fleet/home/.env (the secrets feed did not answer; try again).");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: STT_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Transcribe the speech in the audio exactly as spoken. Output only the transcript text: no quotes, no labels, no reply to what is said. If the audio has no clear speech (silence, noise, music), output exactly ${NO_SPEECH} and nothing else. Spelling hints, only for words actually spoken (never output them otherwise): ${VOCAB}.`,
        },
        { role: "user", content: [{ type: "input_audio", input_audio: { data: Buffer.from(wav).toString("base64"), format: "wav" } }] },
      ],
    }),
  });
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number }; error?: { message?: string } };
  if (!res.ok) throw new Error(j.error?.message ?? `transcription failed (${res.status})`);
  const raw = (j.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
  return { text: echoedHints(raw) ? "" : raw, cost: j.usage?.cost ?? 0 };
}
