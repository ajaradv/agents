import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "live-voice-"));
mkdirSync(join(inbox, ".node"), { recursive: true });
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { LiveSession, liveVoiceFor, persona, goPolicy } = await import("./live-voice.ts");
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
    const s = new LiveSession({ audio: (p) => void audio.push(p), event: (e) => void events.push(e), close: () => void (closed = true) }, { agent: "alice", connect: (url) => (expect(url).toContain("key=test-key"), up as never), key: async () => "test-key", briefing: async () => "4 ships, pochteca docked." });
    await s.start();
    up.onopen();
    expect(up.sent[0].setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(up.sent[0].setup.systemInstruction.parts[0].text).toContain("Alice");
    expect(up.sent[0].setup.systemInstruction.parts[0].text).toContain("pochteca docked");
    expect(up.sent[0].setup.systemInstruction.parts[0].text).toContain("royal princess");
    expect(liveVoiceFor("alice")).toBe("Sulafat");
    // Her configured voice (agents/alice/agent.yaml live_voice), whatever the captain picked.
    expect(up.sent[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(liveVoiceFor("alice"));
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
  test("the voice persona keeps replies short, carries the character and the snapshot, and invents nothing", () => {
    const p = persona("alice", "A runaway princess.", "pochteca docked");
    expect(p).toContain("one to three sentences");
    expect(p).toContain("A runaway princess.");
    expect(p).toContain("pochteca docked");
    expect(p).toContain("Never invent fleet facts");
  });
});

describe("live tools (V2)", () => {
  test("a tool call is answered from fleet data, shown in the action log, and the setup declares the tools", async () => {
    const up = fakeUpstream();
    const events: any[] = [];
    const s = new LiveSession({ audio: () => {}, event: (e) => void events.push(e), close: () => {} }, { agent: "alice", connect: () => up as never, key: async () => "k", briefing: async () => "", tool: async (name, args) => ({ result: `${name}:${JSON.stringify(args)} -> 2 in progress`, summary: "listed in-progress vault tasks" }) });
    await s.start();
    up.onopen();
    expect(up.sent[0].setup.tools[0].functionDeclarations.map((f: any) => f.name)).toEqual(["fleet_status", "ship", "vault_tasks"]);
    up.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    await tick();
    up.onmessage({ data: JSON.stringify({ toolCall: { functionCalls: [{ id: "c1", name: "vault_tasks", args: { filter: "in-progress" } }] } }) });
    await tick();
    await tick();
    const reply = up.sent.at(-1);
    expect(reply.toolResponse.functionResponses[0]).toEqual({ id: "c1", name: "vault_tasks", response: { result: 'vault_tasks:{"filter":"in-progress"} -> 2 in progress' } });
    expect(events.find((e) => e.type === "action")).toMatchObject({ name: "vault_tasks", summary: "listed in-progress vault tasks" });
  });
});

describe("acting by voice (V3)", () => {
  test("the policy door: a Go needs the captain's own clear go; a refusal needs a clear no", () => {
    expect(goPolicy("go", "Yes, go ahead and dock it")).toBeNull();
    expect(goPolicy("go", "Hmm, what would that do?")).toContain("not a clear go");
    expect(goPolicy("go", "No, don't do that")).toContain("not a clear go");
    expect(goPolicy("no", "No, leave it")).toBeNull();
    expect(goPolicy("go", "")).toContain("has not said");
  });
  test("ask_alice hands off; decide_go is held until the captain says go, then decides; Alice's reply is relayed", async () => {
    const up = fakeUpstream();
    const events: any[] = [];
    const sent: string[] = [];
    const decided: [string, boolean][] = [];
    const actions = {
      sendToAlice: async (t: string) => void sent.push(t),
      needsYou: async () => [{ id: "go:g1", kind: "go", goId: "g1", summary: "Dock fleet's voyage." }],
      decideGo: async (id: string, go: boolean) => (decided.push([id, go]), { ok: true, message: "Docked." }),
    };
    const s = new LiveSession({ audio: () => {}, event: (e) => void events.push(e), close: () => {} }, { agent: "alice", connect: () => up as never, key: async () => "k", briefing: async () => "", actions });
    await s.start();
    up.onopen();
    expect(up.sent[0].setup.tools[0].functionDeclarations.map((f: any) => f.name)).toContain("decide_go");
    up.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    await tick();
    const call = async (id: string, name: string, args: object) => {
      up.onmessage({ data: JSON.stringify({ toolCall: { functionCalls: [{ id, name, args }] } }) });
      for (let i = 0; i < 4; i++) await tick();
      return up.sent.at(-1).toolResponse.functionResponses[0].response.result as string;
    };
    expect(await call("a", "ask_alice", { message: "dock the fleet ship" })).toContain("Sent to Alice");
    expect(sent).toEqual(["(by voice) dock the fleet ship"]);
    up.onmessage({ data: JSON.stringify({ serverContent: { inputTranscription: { text: "What does that request do?" } } }) });
    expect(await call("b", "decide_go", { go_id: "g1", decision: "go" })).toContain("not a clear go");
    expect(decided).toEqual([]);
    expect(events.filter((e) => e.type === "action").at(-1).verdict).toBe("blocked");
    up.onmessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    up.onmessage({ data: JSON.stringify({ serverContent: { inputTranscription: { text: "Yes, go ahead." } } }) });
    expect(await call("c", "decide_go", { go_id: "g1", decision: "go" })).toBe("Docked.");
    expect(decided).toEqual([["g1", true]]);
    s.relay("The fleet ship is docked; the helmsman is reviewing.");
    expect(up.sent.at(-1).realtimeInput.text).toContain("the helmsman is reviewing");
  });
});
