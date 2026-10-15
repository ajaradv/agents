import { describe, expect, test } from "bun:test";
import "../public/md.js";

const g = globalThis as unknown as {
  renderMarkdown: (s: string) => string;
  formatDuration: (ms: number) => string;
  humanizeError: (s: string) => { summary: string; raw: string; folded: boolean };
  speechChunk: (text: string, from: number, min?: number, final?: boolean) => { chunk: string; next: number } | null;
  spokenLimit: (text: string, budget?: number) => { limit: number; cut: boolean };
  shipBadge: (ship: string) => { text: string; color: string } | null;
};

describe("renderMarkdown", () => {
  test("never lets markup through", () => {
    const html = g.renderMarkdown('<img src=x onerror="alert(1)"> **hi** [x](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>hi</strong>");
    expect(html).not.toContain('href="javascript');
  });
  test("headings, lists, code, tables", () => {
    const html = g.renderMarkdown("## What changed\n\n- **Hero:** new\n- `home.html` edited\n\n```\nconst a = 1 < 2;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<h4>What changed</h4>");
    expect(html).toContain("<ul><li><strong>Hero:</strong> new</li><li><code>home.html</code> edited</li></ul>");
    expect(html).toContain("<pre><code>const a = 1 &lt; 2;</code></pre>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>2</td>");
  });
  test("a list right under a line of text is still a list", () => {
    expect(g.renderMarkdown("Part 2, the project list:\n- Add D5a\n- Move D4\nThen this.")).toBe(
      "<p>Part 2, the project list:</p><ul><li>Add D5a</li><li>Move D4</li></ul><p>Then this.</p>",
    );
    expect(g.renderMarkdown("Steps:\n1. one\n2. two")).toBe("<p>Steps:</p><ol><li>one</li><li>two</li></ol>");
  });
  test("code is left alone and identifiers keep underscores", () => {
    expect(g.renderMarkdown("run `**not bold**` in snake_case_name")).toBe("<p>run <code>**not bold**</code> in snake_case_name</p>");
  });
  test("links open in a new tab; paragraphs keep line breaks", () => {
    const html = g.renderMarkdown("See https://example.com/a.\nNext line");
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener">https://example.com/a</a>.');
    expect(html).toContain("<br />Next line");
  });
});

describe("formatDuration", () => {
  test("reads like a person wrote it", () => {
    expect(g.formatDuration(850)).toBe("850ms");
    expect(g.formatDuration(12_400)).toBe("12s");
    expect(g.formatDuration(171_796)).toBe("2m 52s");
    expect(g.formatDuration(3_780_000)).toBe("1h 3m");
  });
});

describe("humanizeError", () => {
  test("pulls the message out of provider JSON", () => {
    const e = g.humanizeError('402 {"type":"error","error":{"type":"billing_error","message":"This request requires more credits."}}');
    expect(e.summary).toBe("402: This request requires more credits.");
    expect(e.folded).toBe(true);
  });
  test("unwraps a bridge's nested upstream error", () => {
    const e = g.humanizeError('477 {"error":{"message":"Exception during request with code 477: {\\"message\\":\\"Out of quota\\"}","type":"upstream_error"}}');
    expect(e.summary).toBe("477: Out of quota");
  });
  test("a dropped model stream reads as one sentence", () => {
    const e = g.humanizeError("Could not parse Anthropic SSE event content_block_delta: Unexpected end of JSON input; data=; raw=event: content_block_delta");
    expect(e.summary).toBe("The model's connection dropped mid-reply.");
    expect(e.folded).toBe(true);
  });
  test("keeps the first line of multi-line errors", () => {
    expect(g.humanizeError("No API key found for openrouter.\n\nUse /login …").summary).toBe("No API key found for openrouter.");
  });
});

import { humanizeError as serverHumanize, plainSummary } from "./humanize.ts";

describe("server humanize", () => {
  test("turn failures read as a sentence", () => {
    expect(serverHumanize('Turn failed after 5s: 402 {"error":{"message":"This request requires more credits."}}')).toBe(
      "Turn failed after 5s: 402: This request requires more credits.",
    );
  });
  test("summaries drop markdown punctuation", () => {
    expect(plainSummary("## What changed\n\n- **Hero:** `home.html` updated")).toBe("What changed · Hero: home.html updated");
  });
});

describe("speechChunk", () => {
  test("waits for a finished sentence of reasonable length", () => {
    expect(g.speechChunk("Kinwork is docked and the designer", 0)).toBeNull();
    expect(g.speechChunk("Short. ", 0)).toBeNull();
    const a = g.speechChunk("Kinwork is docked and the designer is idle. The lead has", 0)!;
    expect(a.chunk).toBe("Kinwork is docked and the designer is idle.");
    expect(g.speechChunk("Kinwork is docked and the designer is idle. The lead has", a.next)).toBeNull();
  });
  test("takes several sentences at once and lines without periods", () => {
    const t = "One thing is waiting on you right now.\n- pochteca-scout failed on a 503\n- the rest";
    expect(g.speechChunk(t, 0)!.chunk).toBe("One thing is waiting on you right now.\n- pochteca-scout failed on a 503\n");
  });
  test("never cuts inside an open code fence", () => {
    const t = "Here is the exact command you asked me for:\n```\nbun test lib/one.test.ts. Then more\n";
    expect(g.speechChunk(t, 0)!.chunk).toBe("Here is the exact command you asked me for:\n");
  });
  test("final sends the rest", () => {
    expect(g.speechChunk("Done. ok", 6, 40, true)).toEqual({ chunk: "ok", next: 8 });
    expect(g.speechChunk("Done.", 5, 40, true)).toBeNull();
  });
});

describe("spokenLimit", () => {
  test("a short prose reply is spoken whole", () => {
    expect(g.spokenLimit("Kinwork is docked. The designer is idle.")).toEqual({ limit: 40, cut: false });
  });
  test("speech stops where a table, list, or heading starts", () => {
    const t = "Here you go, Captain: four ships, and Kinwork is the busiest.\n\n| Ship | State |\n|---|---|\n| kinwork | docked |";
    const r = g.spokenLimit(t);
    expect(t.slice(0, r.limit)).toBe("Here you go, Captain: four ships, and Kinwork is the busiest.\n");
    expect(r.cut).toBe(true);
    const d = "Done.\n- one\n- two";
    expect(d.slice(0, g.spokenLimit(d).limit)).toBe("Done.");
  });
  test("long prose is cut at a sentence end within the budget, never mid-sentence", () => {
    const s = "This sentence is exactly fifty characters long ok. ";
    const t = s.repeat(12);
    const r = g.spokenLimit(t, 350);
    expect(r.limit).toBe(s.length * 6 - 1); // six 51-char sentences fit in 350; a seventh would not
    expect(r.cut).toBe(true);
  });
  test("a first sentence longer than the budget is still said whole", () => {
    const t = "A".repeat(500) + ". Then more.";
    expect(g.spokenLimit(t, 350).limit).toBe(501);
  });
});

describe("shipBadge", () => {
  test("initials from the ship id, a stable colour per ship, never the waiting red", () => {
    expect(g.shipBadge("kinwork")!.text).toBe("KI");
    expect(g.shipBadge("lineage_atria")!.text).toBe("LA");
    expect(g.shipBadge("kinwork")!.color).toBe(g.shipBadge("kinwork")!.color);
    expect(g.shipBadge("pochteca")!.color).not.toBe("#9c1230");
    expect(g.shipBadge("")).toBeNull();
  });
});
