import { describe, expect, test } from "bun:test";
import "../public/md.js";

const g = globalThis as unknown as {
  renderMarkdown: (s: string) => string;
  formatDuration: (ms: number) => string;
  humanizeError: (s: string) => { summary: string; raw: string; folded: boolean };
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
