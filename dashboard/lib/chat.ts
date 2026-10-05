import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

export type ChatLine = {
  ts: string;
  from: string;
  kind: "chat";
  text: string;
};

const CHAT_AGENTS = new Set(["alice", "firstmate", "architect"]);

export function chatAllowed(agentId: string): boolean {
  return CHAT_AGENTS.has(agentId);
}

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
  await appendFile(chatPath(agentId), JSON.stringify(line) + "\n", "utf8");
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
