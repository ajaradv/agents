import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "vault-reader-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const shipsDir = mkdtempSync(join(tmpdir(), "vault-reader-ships-"));
const prevShips = process.env.FLEET_SHIPS_DIR;
process.env.FLEET_SHIPS_DIR = shipsDir;
const reader = await import("./vault-reader.ts");
const page = await import("./ships-page.ts");
const j = await import("./journal.ts");
afterAll(() => {
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  if (prevShips === undefined) delete process.env.FLEET_SHIPS_DIR;
  else process.env.FLEET_SHIPS_DIR = prevShips;
});

const vault = mkdtempSync(join(tmpdir(), "vault-reader-vault-"));
const outside = mkdtempSync(join(tmpdir(), "vault-reader-outside-"));
const put = (rel: string, text: string) => {
  mkdirSync(join(vault, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(vault, rel), text);
};
put("fleet/plans/jev.md", "---\ntitle: Jev plan\nstatus: accepted\nsummary: Jev answers questions.\n---\n\nSee [[ship-rigging]], [[ship-rigging|the rigging]], [[nope]], and `[[in-code]]`.\n\n![[pic.png]] ![rel](../../art/pic.png)\n\n<script>alert(1)</script>\n");
put("fleet/plans/ship-rigging.md", "---\ntitle: Ship rigging\n---\n\nbody quokkas\n");
put("fleet/specs/ship-rigging.md", "other one\n");
put("art/pic.png", "png");
put("career/cv.md", "secret\n");
put("profile/me.md", "secret\n");
put("templates/t.md", "t\n");
put(".obsidian/app.json", "{}");
put(".pi/x.md", "x\n");
put("tasks/t1.md", "---\ntitle: A task\n---\nx\n");
writeFileSync(join(outside, "out.md"), "outside\n");
symlinkSync(outside, join(vault, "link-out"));
symlinkSync(join(vault, "career"), join(vault, "link-career"));

const get = (path: string) => reader.vaultResponse(path, new URLSearchParams(), vault);

describe("vault path guard", () => {
  for (const p of ["/vault/career/cv.md", "/vault/career/", "/vault/profile/me.md", "/vault/templates/t.md", "/vault/.obsidian/app.json", "/vault/.pi/x.md", "/vault/../etc/passwd", "/vault/fleet/../../etc/passwd", "/vault/%2e%2e/%2e%2e/etc/passwd", "/vault/%2Fetc/passwd", "/vault/link-out/out.md", "/vault/link-career/cv.md", "/vault/nothing.md", "/vault/art/pic.txt"]) {
    test(`404 for ${p}`, async () => {
      expect((await get(p)).status).toBe(404);
    });
  }
  test("guardVaultPath rejects traversal, absolute and backslash paths", () => {
    for (const p of ["../x", "a/../../x", "/etc/passwd", "a\\..\\b", "a\0b", ".git/config"]) expect(reader.guardVaultPath(p, vault)).toBeNull();
  });
  test("the root listing hides blocked folders", async () => {
    const html = await (await get("/vault/")).text();
    expect(html).toContain("fleet/");
    expect(html).not.toMatch(/career|profile|templates|\.obsidian|link-career/);
  });
});

describe("vault reader", () => {
  test("renders a note with its header and resolved wiki links", async () => {
    const r = await get("/vault/fleet/plans/jev.md");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain("<h1>Jev plan</h1>");
    expect(html).toContain("status: accepted");
    expect(html).toContain("Jev answers questions.");
    expect(html).toContain('href="/vault/fleet/plans/ship-rigging.md"'); // same folder beats fleet/specs
    expect(html).toContain(">the rigging</a>");
    expect(html).toContain('class="dead"');
    expect(html).toContain("[[in-code]]");
    expect(html).toContain('src="/vault/art/pic.png"');
  });
  test("wiki target resolution", () => {
    const files = ["fleet/plans/ship-rigging.md", "fleet/specs/ship-rigging.md", "a/b.md", "art/Pic.PNG"];
    expect(reader.resolveWikiTarget("ship-rigging", files, "fleet/specs")).toBe("fleet/specs/ship-rigging.md");
    expect(reader.resolveWikiTarget("Ship-Rigging#Heading", files, "")).toBe("fleet/plans/ship-rigging.md");
    expect(reader.resolveWikiTarget("a/b", files)).toBe("a/b.md");
    expect(reader.resolveWikiTarget("b.md", files)).toBe("a/b.md");
    expect(reader.resolveWikiTarget("pic.png", files)).toBe("art/Pic.PNG");
    expect(reader.resolveWikiTarget("missing", files)).toBeNull();
  });
  test("serves an image and a folder", async () => {
    expect((await get("/vault/art/pic.png")).headers.get("content-type")).toBe("image/png");
    const html = await (await get("/vault/fleet/plans/")).text();
    expect(html).toContain("Jev plan");
    expect(html).toContain("Jev answers questions.");
  });
  test("search renders the node's hits and drops blocked paths", async () => {
    const asked: string[] = [];
    const stub = async (q: string) => {
      asked.push(q);
      return {
        ok: true,
        message: "2 note(s) match",
        hits: [
          { path: "fleet/plans/ship-rigging.md", title: "Ship rigging", status: null, summary: null, section: "(top)", snippet: "body «quokkas»" },
          { path: "career/cv.md", title: "CV", status: null, summary: null, snippet: "«secret»" },
        ],
      };
    };
    const html = await (await reader.vaultResponse("/vault/", new URLSearchParams({ q: "quokkas" }), vault, stub)).text();
    expect(asked).toEqual(["quokkas"]);
    expect(html).toContain("Ship rigging");
    expect(html).toContain("<mark>quokkas</mark>");
    expect(html).not.toContain("career");
  });
  test("search says so when the node is down, without a local fallback", async () => {
    const r = await reader.vaultResponse("/vault/", new URLSearchParams({ q: "quokkas" }), vault, async () => null);
    expect(await r.text()).toContain("Search is unavailable while the fleet node is down.");
  });
});

describe("ships page", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  put("ships/fresh/roadmap.md", "---\ntype: roadmap\nupdated: 2026-11-08\nsummary: Fresh ship.\n---\n\n## Now\nBuilding **P3**.\n\n## Milestones\n| a |\n\n## Next up\n1. First item\n   with more\n2. Second\n3. Third\n4. Fourth\n\n## Recently done\nx\n\n## Open questions for the captain\n- Which one?\n");
  put("ships/stale/roadmap.md", "---\nupdated: 2026-10-20\nsummary: Old one.\n---\n\n## Now\nWaiting.\n");
  for (const id of ["fresh", "stale", "gone"]) writeFileSync(join(shipsDir, `${id}.yaml`), `id: ${id}\n`);

  test("reads a roadmap into a card", () => {
    const c = page.readShipCard("fresh", vault, now);
    expect(c).toMatchObject({ found: true, summary: "Fresh ship.", updated: "2026-11-08", days: 2, stale: false, now: "Building **P3**." });
    expect(c.next).toEqual(["First item with more", "Second", "Third"]);
    expect(c.questions).toBe("- Which one?");
  });
  test("a stale note is flagged, a missing one says so", () => {
    const s = page.readShipCard("stale", vault, now);
    expect(s).toMatchObject({ found: true, days: 21, stale: true, next: [], questions: "" });
    expect(page.readShipCard("gone", vault, now).found).toBe(false);
  });
  test("the page has a card per ship with badges", async () => {
    const html = await page.shipsPageResponse(vault, now).text();
    expect(html.match(/class="card"/g)?.length).toBe(3);
    expect(html).toContain("updated 2 days ago");
    expect(html).toContain('class="chip warn">updated 21 days ago');
    expect(html).toContain("no roadmap yet");
    expect(html).toContain('href="/vault/ships/fresh/roadmap.md"');
    expect(html).toContain("<strong>P3</strong>");
  });
});
