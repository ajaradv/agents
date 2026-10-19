import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkImages, lookAt } from "./look.ts";

const dir = mkdtempSync(join(tmpdir(), "look-"));
const png = join(dir, "shot.png");
writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));

describe("crew eyes", () => {
  test("only images, only from allowed folders, at most four", () => {
    expect(checkImages([png], [dir]).ok).toBe(true);
    expect(checkImages([], [dir])).toMatchObject({ ok: false });
    expect(checkImages([png, png, png, png, png], [dir])).toMatchObject({ ok: false });
    writeFileSync(join(dir, "notes.txt"), "secret");
    expect(checkImages([join(dir, "notes.txt")], [dir])).toMatchObject({ ok: false });
    expect(checkImages([png], [join(dir, "elsewhere")]).ok).toBe(true); // no root exists: nothing to confine to
    const other = mkdtempSync(join(tmpdir(), "look-other-"));
    expect(checkImages([png], [other])).toMatchObject({ ok: false });
  });
  test("the image goes to the model as a data URL with the question; the answer and cost come back", async () => {
    let sent: any = null;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "A red flag on the mast." } }], usage: { cost: 0.0006 } }));
    }) as unknown as typeof fetch;
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    const r = await lookAt([{ path: png, type: "image/png" }], "Is there a flag?", fake);
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
    expect(r).toMatchObject({ ok: true, answer: "A red flag on the mast.", cost: 0.0006 });
    expect(sent.messages[0].content[0].text).toContain("Is there a flag?");
    expect(sent.messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,");
    expect(sent.provider).toEqual({ data_collection: "deny" });
  });
});
