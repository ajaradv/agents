import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crewCaller } from "./agent-host.ts";
import { confinedFile } from "./canvas.ts";
import { requestRefusal } from "./request-guard.ts";
import type { ShipEvent } from "./ship-log.ts";
import { crewStatus } from "./ship-view.ts";

const PORT = 8787;
const req = (method: string, headers: Record<string, string> = {}, path = "/chat/designer") =>
  new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } });

describe("requestRefusal (other pages driving the dashboard)", () => {
  test("the dashboard's own pages may write", () => {
    expect(requestRefusal(req("POST", { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" }), PORT)).toBeNull();
    expect(requestRefusal(req("POST", { origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }), PORT)).toBeNull();
  });
  test("agents, extensions, and curl send no Origin and pass", () => {
    expect(requestRefusal(req("POST"), PORT)).toBeNull();
  });
  test("another site cannot POST, even as a simple request", () => {
    expect(requestRefusal(req("POST", { origin: "https://evil.example" }), PORT)).toBe("cross-origin request");
    expect(requestRefusal(req("POST", { origin: "null" }), PORT)).toBe("cross-origin request");
    // Same site, other port (e.g. a dev server on :3000) is still another page.
    expect(requestRefusal(req("POST", { origin: "http://localhost:3000" }), PORT)).toBe("cross-origin request");
    expect(requestRefusal(req("POST", { "sec-fetch-site": "cross-site" }), PORT)).toBe("cross-site request");
  });
  test("another site cannot open a chat WebSocket", () => {
    const ws = req("GET", { upgrade: "websocket", origin: "https://evil.example" }, "/ws/chat/designer");
    expect(requestRefusal(ws, PORT)).toBe("cross-origin request");
    const own = req("GET", { upgrade: "websocket", origin: `http://127.0.0.1:${PORT}` }, "/ws/chat/designer");
    expect(requestRefusal(own, PORT)).toBeNull();
  });
  test("reads stay open; a foreign Host (DNS rebinding) does not", () => {
    expect(requestRefusal(req("GET", { origin: "https://evil.example" }, "/api/state"), PORT)).toBeNull();
    expect(requestRefusal(req("GET", { host: "rebind.evil.example:8787" }, "/api/state"), PORT)).toBe("unknown host");
  });
});

describe("crewCaller", () => {
  test("an unknown or empty token is nobody", () => {
    expect(crewCaller("")).toBeNull();
    expect(crewCaller("not-a-token")).toBeNull();
  });
});

describe("confinedFile (canvas)", () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-test-"));
  const base = join(root, "item");
  mkdirSync(join(base, "site"), { recursive: true });
  writeFileSync(join(base, "site", "index.html"), "<p>hi</p>");
  writeFileSync(join(root, "secret.env"), "KEY=1");
  symlinkSync(join(root, "secret.env"), join(base, "site", "config"));

  test("serves files inside the item", async () => {
    expect(await confinedFile(base, "site/index.html")).toEndWith("/site/index.html");
  });
  test("refuses traversal, symlinks out, and folders", async () => {
    expect(await confinedFile(base, "../secret.env")).toBeNull();
    expect(await confinedFile(base, "site/config")).toBeNull();
    expect(await confinedFile(base, "site")).toBeNull();
    expect(await confinedFile(base, "site/missing.html")).toBeNull();
  });
});

describe("crewStatus (Needs you per crewmate)", () => {
  const ev = (id: number, ts: string, actor: string, kind: string, payload: Record<string, unknown> | null = null): ShipEvent => ({
    id, ts, actor, kind, summary: kind, payload,
  });
  test("a message to another crewmate does not clear a question", () => {
    const events = [
      ev(2, "2026-10-13T10:05:00Z", "captain", "chat-in", { to: "kin-lead" }),
      ev(1, "2026-10-13T10:00:00Z", "kin-designer", "question"),
    ];
    expect(crewStatus("kin-designer", events).status).toBe("waiting");
  });
  test("an answer to that crewmate does", () => {
    const events = [
      ev(2, "2026-10-13T10:05:00Z", "captain", "answer", { to: "kin-designer" }),
      ev(1, "2026-10-13T10:00:00Z", "kin-designer", "question"),
    ];
    expect(crewStatus("kin-designer", events).status).not.toBe("waiting");
  });
});
