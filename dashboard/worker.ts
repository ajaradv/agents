/**
 * The laptop worker: what the always-on hub borrows from the captain's laptop
 * while it is awake (lib/laptop.ts is the hub's side).
 *
 * - GET  /health      capabilities right now: "tts" (Kokoro is set up), "firstmate" (its TUI answers)
 * - POST /tts         {text, voice, speed} → WAV (lib/voice.ts synthesize, the M2 Max's Kokoro)
 * - POST /firstmate   {text} → typed into Firstmate's TUI (lib/firstmate-chat.ts)
 *
 * Listens on 127.0.0.1 only; Tailscale Serve publishes it to the tailnet
 * (bin/laptop-worker --install). Every request needs the shared token
 * (secret "laptop-worker-token", the Keychain here, a 0600 file on the hub).
 */
import { timingSafeEqual } from "node:crypto";
import { firstmateTuiReachable, sendToFirstmateTui } from "./lib/firstmate-chat.ts";
import { readSecret } from "./lib/secret-store.ts";
import { synthesize, ttsAvailable } from "./lib/voice.ts";

const PORT = Number(process.env.FLEET_WORKER_PORT) || 8790;

/** Constant-time check of "Bearer <token>" against the stored token; no token stored means no access. */
export function authorized(header: string | null, token: string): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function capabilities(): Promise<string[]> {
  const caps: string[] = [];
  if (ttsAvailable()) caps.push("tts");
  if ((await firstmateTuiReachable().catch(() => ({ ok: false }))).ok) caps.push("firstmate");
  return caps;
}

if (import.meta.main) {
  let token = await readSecret("laptop-worker-token");
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(req) {
      if (!token) token = await readSecret("laptop-worker-token");
      if (!authorized(req.headers.get("authorization"), token)) return new Response("unauthorized", { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/health" && req.method === "GET") return Response.json({ ok: true, capabilities: await capabilities(), host: "laptop" });
      if (path === "/tts" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { text?: string; voice?: string; speed?: number };
        const text = String(b.text ?? "").slice(0, 2000);
        if (!text.trim() || !/^[ab][fm]_[a-z]+$/.test(String(b.voice))) return Response.json({ ok: false, message: "text and a Kokoro voice id" }, { status: 400 });
        try {
          return new Response(new Uint8Array(await synthesize(text, String(b.voice), Number(b.speed) || 1.0)), { headers: { "Content-Type": "audio/wav" } });
        } catch (e) {
          return Response.json({ ok: false, message: e instanceof Error ? e.message : "speech failed" }, { status: 503 });
        }
      }
      if (path === "/firstmate" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { text?: string };
        const text = String(b.text ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        if (!text) return Response.json({ ok: false, detail: "no text" }, { status: 400 });
        const r = await sendToFirstmateTui(text);
        return Response.json({ ok: r.ok, detail: r.ok ? "fm-send" : (r.stderr || r.stdout || "TUI not reachable").trim().slice(0, 400) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`laptop worker http://127.0.0.1:${PORT}`);
}
