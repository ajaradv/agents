import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chatAllowed, chatTarget, markTaskThread } from "./chat-targets.ts";
import { fleetInboxRoot } from "./paths.ts";

export { chatAllowed };

/**
 * One line of fleet/inbox/<id>/captain-chat.jsonl.
 * kind "error" is a failed send: `reason` says why and `ref` is the ts of the
 * captain line it failed; `text` repeats the reason for older readers.
 * kind "question" is an agent's ask_captain call: `questions` carries the
 * options the drawer draws as buttons; `text` is a plain rendering of them.
 */
export type ChatQuestion = { id: string; question: string; options?: string[]; recommended?: string };

export type ChatLine = {
  ts: string;
  from: string;
  kind: "chat" | "error" | "question";
  text: string;
  reason?: string;
  ref?: string;
  questions?: ChatQuestion[];
};

function chatPath(agentId: string): string {
  return join(fleetInboxRoot(), agentId, "captain-chat.jsonl");
}

function busPath(agentId: string): string {
  return join(fleetInboxRoot(), agentId, "events.jsonl");
}

export async function appendCaptainChat(
  agentId: string,
  text: string,
): Promise<ChatLine> {
  if (!chatAllowed(agentId)) throw new Error("chat not enabled for agent");
  const line: ChatLine = {
    ts: new Date().toISOString(),
    from: "captain",
    kind: "chat",
    text: text.trim(),
  };
  if (!line.text) throw new Error("empty message");
  const dir = join(fleetInboxRoot(), agentId);
  await mkdir(dir, { recursive: true });
  const target = chatTarget(agentId);
  if (target?.kind === "task") await markTaskThread(agentId);
  await appendFile(chatPath(agentId), JSON.stringify(line) + "\n", "utf8");
  if (target?.kind === "task") return line;
  const wake = {
    ts: line.ts,
    from: "dashboard",
    kind: "captain-chat",
    summary: line.text.slice(0, 200),
  };
  await appendFile(busPath(agentId), JSON.stringify(wake) + "\n", "utf8");
  return line;
}

export async function appendAgentChat(
  agentId: string,
  from: string,
  text: string,
): Promise<ChatLine> {
  if (!chatAllowed(agentId)) throw new Error("chat not enabled for agent");
  const line: ChatLine = {
    ts: new Date().toISOString(),
    from,
    kind: "chat",
    text: text.trim(),
  };
  if (!line.text) throw new Error("empty message");
  const dir = join(fleetInboxRoot(), agentId);
  await mkdir(dir, { recursive: true });
  await appendFile(chatPath(agentId), JSON.stringify(line) + "\n", "utf8");
  return line;
}

/** Record a failed send under the captain line it belongs to. */
export async function appendChatError(
  agentId: string,
  reason: string,
  ref?: string,
): Promise<ChatLine> {
  const text = reason.trim() || "send failed";
  const line: ChatLine = {
    ts: new Date().toISOString(),
    from: "dashboard",
    kind: "error",
    text,
    reason: text,
    ...(ref ? { ref } : {}),
  };
  await mkdir(join(fleetInboxRoot(), agentId), { recursive: true });
  await appendFile(chatPath(agentId), JSON.stringify(line) + "\n", "utf8");
  return line;
}

export function chatLogPath(agentId: string): string {
  return chatPath(agentId);
}

export async function readCaptainChat(
  agentId: string,
  limit = 200,
): Promise<ChatLine[]> {
  if (!chatAllowed(agentId)) return [];
  try {
    const raw = await readFile(chatPath(agentId), "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as ChatLine);
    return lines;
  } catch {
    return [];
  }
}

/** Plain text of a question set, for the jsonl `text` field and turn history. */
export function questionsText(context: string, questions: ChatQuestion[]): string {
  const lines = questions.map((q) => {
    const opts = (q.options ?? []).map((o) => (o === q.recommended ? `${o} (recommended)` : o));
    return `- ${q.question}${opts.length ? ` Options: ${opts.join(" / ")}` : ""}`;
  });
  return [context ? `Question for you: ${context}` : "Question for you:", ...lines].join("\n");
}

function cleanQuestions(raw: unknown): ChatQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatQuestion[] = [];
  for (const q of raw.slice(0, 8)) {
    if (!q || typeof q !== "object") continue;
    const o = q as Record<string, unknown>;
    const question = String(o.question ?? "").trim().slice(0, 400);
    if (!question) continue;
    const options = Array.isArray(o.options)
      ? o.options.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 5)
      : [];
    const recommended = typeof o.recommended === "string" && options.includes(o.recommended) ? o.recommended : undefined;
    out.push({ id: String(o.id ?? `q${out.length + 1}`).slice(0, 60), question, options, ...(recommended ? { recommended } : {}) });
  }
  return out;
}

/**
 * Move questions an agent posted with ask_captain during its turn
 * (fleet/inbox/<id>/pending-questions.json) into the chat as one question line.
 */
export async function takePendingQuestions(agentId: string): Promise<ChatLine | null> {
  const path = join(fleetInboxRoot(), agentId, "pending-questions.json");
  let raw: { context?: unknown; questions?: unknown };
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  } finally {
    await rm(path, { force: true });
  }
  const questions = cleanQuestions(raw.questions);
  if (questions.length === 0) return null;
  const context = typeof raw.context === "string" ? raw.context.trim().slice(0, 600) : "";
  const line: ChatLine = {
    ts: new Date().toISOString(),
    from: agentId,
    kind: "question",
    text: questionsText(context, questions),
    questions,
  };
  await mkdir(join(fleetInboxRoot(), agentId), { recursive: true });
  await appendFile(chatPath(agentId), JSON.stringify(line) + "\n", "utf8");
  return line;
}
