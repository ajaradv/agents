import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "live-voice-"));
mkdirSync(join(inbox, ".node"), { recursive: true });
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { LiveSession, persona } = await import("./live-voice.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

function fakeUpstream() {
  const sent: any[] = [];
  const up = { sent, onopen: null as any, onmessage: null as any, onclose: null as any, onerror: null as any, send: (d: string) => void sent.push(JSON.parse(d)), close: () => up.onclose?.({ code: 1000, reason: "" }) };
  return up;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("conversation mode bridge (V1)", () => {
  test("setup, audio both ways, transcripts, interruptions, and a logged turn", async () => {
    const up = fakeUpstream();
    const audio: Uint8Array[] = [];
    const events: any[] = [];
    let closed = false;
    const s = new LiveSession({ audio: (p) => void audio.push(p), event: (e) => void events.push(e), close: () => void (closed = true) }, { agent: "alice", connect: (url) => (expect(url).toContain("key=test-key"), up as never), key: async () => "test-key" });
    await s.start();
    up.onopen();
    expect(up.sent[0].setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(up.sent[0].setup.systemInstruction.parts[0].text).toContain("Alice");
    // Words spoken before setup completes are held, then sent.
    s.audio(new Uint8Array([1, 2, 3, 4]));
    expect(up.sent.length).toBe(1);
    up.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    await tick();
    expect(events[0]).toMatchObject({ type: "ready" });
    expect(up.sent[1].realtimeInput.audio).toEqual({ data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "audio/pcm;rate=16000" });
    up.onmessage({ data: JSON.stringify({ serverContent: { inputTranscription: { text: "Hi Alice" } } }) });
    up.onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from([9, 9]).toString("base64") } }] }, outputTranscription: { text: "Hello, Captain." } } }) });
    up.onmessage({ data: JSON.stringify({ serverContent: { interrupted: true } }) });
    up.onmessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    await tick();
    expect(audio[0]).toEqual(new Uint8Array([9, 9]));
    expect(events.map((e) => e.type)).toEqual(["ready", "transcript", "transcript", "interrupted", "turn"]);
    const [file] = readdirSync(join(inbox, "alice", "voice"));
    expect(JSON.parse(readFileSync(join(inbox, "alice", "voice", file!), "utf8").trim())).toMatchObject({ captain: "Hi Alice", agent: "Hello, Captain." });
    s.control(JSON.stringify({ type: "text", text: "What time is it?" }));
    expect(up.sent.at(-1).realtimeInput.text).toBe("What time is it?");
    s.control(JSON.stringify({ type: "end" }));
    expect(closed).toBe(true);
  });
  test("without the free key the session says why and closes", async () => {
    const events: any[] = [];
    let closed = false;
    await new LiveSession({ audio: () => {}, event: (e) => void events.push(e), close: () => void (closed = true) }, { agent: "alice", key: async () => "" }).start();
    expect(events[0].message).toContain("GEMINI_FREE_API_KEY");
    expect(closed).toBe(true);
  });
  test("the voice persona keeps replies short and does not invent fleet facts", () => {
    expect(persona("alice")).toContain("one to three sentences");
    expect(persona("alice")).toContain("Never invent fleet facts");
  });
});
