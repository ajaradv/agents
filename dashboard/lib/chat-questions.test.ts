import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionsText, takePendingQuestions } from "./chat.ts";

const priorInbox = process.env.FLEET_INBOX;
afterAll(() => {
  if (priorInbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = priorInbox;
});

describe("ask_captain pickup", () => {
  test("moves pending questions into one chat line and clears the file", async () => {
    const inbox = mkdtempSync(join(tmpdir(), "fleet-inbox-"));
    process.env.FLEET_INBOX = inbox;
    mkdirSync(join(inbox, "designer"), { recursive: true });
    const pending = join(inbox, "designer", "pending-questions.json");
    writeFileSync(
      pending,
      JSON.stringify({
        context: "Two picks before the build.",
        questions: [
          { id: "quiet-action", question: "Which quiet action?", options: ["See who it is for", "Who it is for"], recommended: "Who it is for" },
          { id: "bad", question: "" },
          { id: "sections", question: "Anything else below the fold?", recommended: "not an option" },
        ],
      }),
    );
    const line = await takePendingQuestions("designer");
    expect(line?.kind).toBe("question");
    expect(line?.questions?.length).toBe(2);
    expect(line?.questions?.[1]?.recommended).toBeUndefined();
    expect(line?.text).toContain("Who it is for (recommended)");
    expect(existsSync(pending)).toBe(false);
    const saved = readFileSync(join(inbox, "designer", "captain-chat.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(saved.at(-1)!).questions[0].id).toBe("quiet-action");
    expect(await takePendingQuestions("designer")).toBeNull();
  });

  test("plain text lists each question", () => {
    expect(questionsText("", [{ id: "a", question: "Pick one?", options: ["x", "y"] }])).toBe("Question for you:\n- Pick one? Options: x / y");
  });
});
