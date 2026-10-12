import { describe, expect, test } from "bun:test";
import { echoedHints, speakable, speechParts, voiceFor } from "./voice.ts";

describe("voice", () => {
  test("roles get their voice, overrides win, others get a stable pick", () => {
    expect(voiceFor("kinwork-designer", "designer")).toBe("af_heart");
    expect(voiceFor("designer", "designer", "bm_lewis")).toBe("bm_lewis");
    expect(voiceFor("designer", "designer", "not a voice")).toBe("af_heart");
    expect(voiceFor("task-123")).toBe(voiceFor("task-123"));
  });

  test("speakable drops code, tables, markdown, links, and long paths", () => {
    const s = speakable("**Done.** See `DESIGN.md` at /Users/me/Workspace/Kinwork/kinwork/templates/home.html\n\n```js\nconst x = 1;\n```\n| a | b |\n|---|---|\nDocs: https://example.com/x");
    expect(s).toContain("Done.");
    expect(s).toContain("DESIGN.md");
    expect(s).toContain("home.html");
    expect(s).not.toContain("/Users/");
    expect(s).not.toContain("const x");
    expect(s).not.toContain("|");
    expect(s).toContain("a link");
    expect(s).not.toContain("**");
  });

  test("speech parts keep every word, even with dots inside words", () => {
    const text = "Done. The page is built. Should I ship it now, or another round first? Screenshots are at desktop.png on the canvas.";
    const parts = speechParts(text, 40, 80);
    expect(parts.join(" ")).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
  });

  test("silence answers and recited hints are not transcripts", () => {
    expect(echoedHints("[no speech]")).toBe(true);
    expect(echoedHints("Kinwork, Pochteca, lineage atria, Firstmate, Alice, Architect.")).toBe(true);
    expect(echoedHints("Kinwork lead, set sail on the mobile fixes.")).toBe(false);
    expect(echoedHints("Ask the scout and the designer.")).toBe(false);
  });

  test("long replies are cut at a sentence", () => {
    const s = speakable("One sentence here. ".repeat(200), 300);
    expect(s.length).toBeLessThan(340);
    expect(s.endsWith("The rest is on screen.")).toBe(true);
  });
});
