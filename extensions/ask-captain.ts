/**
 * ask_captain: a structured clarifying-question tool for fleet agents.
 *
 * - Interactive TUI (ctx.hasUI): asks each question with a picker (plus a
 *   free-text "Other") and returns the answers in the same turn.
 * - Headless dashboard turn (no UI): writes the questions to
 *   $FLEET_INBOX/$FLEET_AGENT_ID/pending-questions.json and tells the model to
 *   end its turn. The dashboard posts them to the chat drawer as clickable
 *   options; the captain's pick arrives as the next message.
 *
 * bin/launch loads this for every assistant and sets FLEET_AGENT_ID.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const OTHER = "Other (type an answer)";

const Question = Type.Object({
  id: Type.String({ description: "Short slug for this question, e.g. quiet-action" }),
  question: Type.String({ description: "One plain question the captain can answer quickly" }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "2-5 concrete answers. The captain can always type another answer.",
      maxItems: 5,
    }),
  ),
  recommended: Type.Optional(Type.String({ description: "The option you recommend, if any (must be one of options)" })),
});

const AskParams = Type.Object({
  context: Type.Optional(Type.String({ description: "One or two sentences on why you are asking" })),
  questions: Type.Array(Question, { minItems: 1, maxItems: 4 }),
});

type Q = { id: string; question: string; options?: string[]; recommended?: string };

function pendingPath(): string | null {
  const agent = process.env.FLEET_AGENT_ID;
  const inbox = process.env.FLEET_INBOX?.replace(/^~/, process.env.HOME ?? "");
  if (!agent || !inbox || !/^[a-z][a-z0-9_-]{0,63}$/.test(agent)) return null;
  return join(inbox, agent, "pending-questions.json");
}

function postPending(context: string | undefined, questions: Q[]): string | null {
  const path = pendingPath();
  if (!path) return null;
  mkdirSync(join(path, ".."), { recursive: true });
  let prior: { context?: string; questions: Q[] } = { questions: [] };
  if (existsSync(path)) {
    try {
      prior = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* replace a broken file */
    }
  }
  const next = {
    context: [prior.context, context].filter(Boolean).join(" "),
    questions: [...(prior.questions ?? []), ...questions],
  };
  writeFileSync(path + ".tmp", JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(path + ".tmp", path);
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_captain",
    label: "Ask captain",
    description:
      "Ask the captain when a decision is theirs (direction, naming, scope, a pick) instead of assuming a default. 2-5 options each, one recommended if you have a view. " +
      "In a dashboard turn, end your turn right after; the answer arrives as their next message.",
    parameters: AskParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = params.questions as Q[];

      if (ctx.hasUI) {
        const lines: string[] = [];
        for (const q of questions) {
          let answer: string | undefined;
          if (q.options && q.options.length > 0) {
            const opts = q.options.map((o) => (o === q.recommended ? `${o} (recommended)` : o));
            const pick = await ctx.ui.select(q.question, [...opts, OTHER]);
            answer = pick === OTHER ? await ctx.ui.input(q.question, "") : pick?.replace(/ \(recommended\)$/, "");
          } else {
            answer = await ctx.ui.input(q.question, "");
          }
          lines.push(`${q.id}: ${answer?.trim() || "(no answer; ask again or hold)"}`);
        }
        return { content: [{ type: "text" as const, text: `Captain answered:\n${lines.join("\n")}` }], details: {} };
      }

      const path = postPending(params.context, questions);
      if (!path) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No answer channel in this session (FLEET_AGENT_ID or FLEET_INBOX unset). Put the questions in your reply and end your turn; do not pick defaults for them.",
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Posted to the captain's chat drawer as clickable options. Do not decide these yourself and do not continue work that depends on them. " +
              "End your turn now with one or two sentences: what you need and what you will do once answered. The captain's answer is the next message.",
          },
        ],
        details: { posted: path },
      };
    },
  });
}
