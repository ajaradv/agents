import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasFileResponse, canvasViewResponse, isLocalUrl, listCanvas } from "./canvas.ts";

const priorInbox = process.env.FLEET_INBOX;
afterAll(() => {
  if (priorInbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = priorInbox;
});

function setup() {
  const inbox = mkdtempSync(join(tmpdir(), "fleet-canvas-"));
  process.env.FLEET_INBOX = inbox;
  const put = (id: string, item: Record<string, unknown>, files: Record<string, string> = {}) => {
    const dir = join(inbox, "designer", "canvas", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "item.json"), JSON.stringify({ id, ...item }));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  };
  return { inbox, put };
}

describe("canvas", () => {
  test("lists items newest first and drops non-local urls", async () => {
    const { put } = setup();
    put("brief", { title: "Brief", kind: "markdown", file: "doc.md", updated: "2026-10-11T10:00:00Z" }, { "doc.md": "# Hi" });
    put("board", { title: "Board", kind: "url", url: "http://127.0.0.1:49458/", updated: "2026-10-11T11:00:00Z" });
    put("evil", { title: "Evil", kind: "url", url: "https://example.com/", updated: "2026-10-11T12:00:00Z" });
    put("mismatch", { id: "other", title: "x", kind: "markdown", updated: "2026-10-11T13:00:00Z" });
    const items = await listCanvas("designer");
    expect(items.map((i) => i.id)).toEqual(["board", "brief"]);
  });

  test("files stay inside the item folder and carry a sandbox CSP", async () => {
    const { put } = setup();
    put("page", { title: "Page", kind: "html", entry: "index.html", updated: "2026-10-11T10:00:00Z" }, { "index.html": "<p>hi</p>" });
    const ok = await canvasFileResponse("designer", "page", "index.html");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Security-Policy")).toStartWith("sandbox allow-scripts");
    expect((await canvasFileResponse("designer", "page", "../../captain-chat.jsonl")).status).toBe(404);
    expect((await canvasFileResponse("designer", "page", "item.json")).status).toBe(404);
    expect((await canvasFileResponse("Designer", "page", "index.html")).status).toBe(404);
  });

  test("markdown and table views render without scripts", async () => {
    const { put } = setup();
    put("doc", { title: "Doc", kind: "markdown", file: "doc.md", updated: "2026-10-11T10:00:00Z" }, { "doc.md": "# Title\n\n<script>x</script>" });
    put("rows", { title: "Rows", kind: "table", file: "rows.json", updated: "2026-10-11T10:00:00Z" }, { "rows.json": JSON.stringify([{ a: 1, b: "<b>" }]) });
    const md = await canvasViewResponse("designer", "doc");
    expect(md.headers.get("Content-Security-Policy")).toStartWith("sandbox;");
    expect(await md.text()).toContain("<h1>Title</h1>");
    const table = await (await canvasViewResponse("designer", "rows")).text();
    expect(table).toContain("<th>a</th>");
    expect(table).toContain("&lt;b&gt;");
  });

  test("local url check", () => {
    expect(isLocalUrl("http://localhost:3000/")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:49458/x")).toBe(true);
    expect(isLocalUrl("https://localhost/")).toBe(false);
    expect(isLocalUrl("http://192.168.1.2/")).toBe(false);
  });
});
