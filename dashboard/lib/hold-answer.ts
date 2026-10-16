import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPaneIsLive } from "./herdr.ts";
import { FM_HOME } from "./firstmate-chat.ts";
import { appendCaptainAnswers, findTaskPlanFile } from "./plan-questions.ts";
import { aliceVault } from "./paths.ts";
import { spawnTimed } from "./proc.ts";
import { readSession } from "./session.ts";

const TASK_ID = /^[a-z][a-z0-9-]{0,63}$/;

export type HoldAnswerResult = {
  ok: boolean;
  status: number;
  html: string;
};

function page(className: string, text: string): string {
  return `<p class="${className}">${escapeText(text)}</p>`;
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function answerCaptainHold(
  taskId: string,
  text: string,
): Promise<HoldAnswerResult> {
  if (!TASK_ID.test(taskId)) {
    return { ok: false, status: 400, html: page("warn", "Unknown hold.") };
  }
  const answer = text.trim();
  if (!answer) {
    return { ok: false, status: 400, html: page("warn", "Write an answer first.") };
  }
  if (answer.length > 8000) {
    return { ok: false, status: 400, html: page("warn", "Answer is too long.") };
  }

  const dir = await mkdtemp(join(tmpdir(), "fm-hold-"));
  const decision = join(dir, "decision.txt");
  try {
    await writeFile(decision, `${answer}\n`, "utf8");
    const script = join(FM_HOME, "bin", "fm-captain-hold.sh");
    const res = await spawnTimed(
      ["bash", script, "answer", taskId, "--decision-file", decision, "--release"],
      {
        timeoutMs: 30_000,
        cwd: FM_HOME,
        env: { ...process.env, FM_HOME },
      },
    );
    if (res.timedOut || res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || "could not record the answer").trim();
      return {
        ok: false,
        status: 400,
        html: page("warn", detail.slice(0, 500)),
      };
    }

    let planNote = "No plan file is linked from this task, so the answer is only on the hold.";
    const planPath = await findTaskPlanFile({
      fmHome: FM_HOME,
      vault: aliceVault(),
      taskId,
    });
    if (planPath) {
      const markdown = await readFile(planPath, "utf8");
      const next = appendCaptainAnswers(markdown, answer);
      if (next !== markdown) await writeFile(planPath, next, "utf8");
      planNote = "The answer is on the hold and in the plan.";
    }

    const session = await readSession("firstmate");
    const pane = await agentPaneIsLive("firstmate", session?.pid);
    const paneNote = pane.live
      ? "It was not typed into the Firstmate TUI."
      : "Firstmate's terminal pane is not attached, so this was not typed into the TUI.";
    return {
      ok: true,
      status: 200,
      html: page("muted", `Answer recorded for ${taskId}. ${planNote} ${paneNote}`),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
