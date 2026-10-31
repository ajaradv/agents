import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Bash use per agent, from the session transcripts ($FLEET_INBOX/<agent>/sessions/*.jsonl):
 * how many bash tool calls, and the first word of each command. The tool gate's log
 * does not record the calls its local rules allow, so this is how the week before an
 * officer loses bash (`-bash` in agent.yaml tools) is checked. Transcripts are large:
 * they are streamed, and only lines that mention bash are parsed.
 */

export type BashUse = { agent: string; toolCalls: number; bashCalls: number; commands: Record<string, number>; last: string };

/** The program a bash command starts: past `VAR=x` prefixes and a leading `cd dir &&`, without its path. */
export function firstWord(command: string): string {
  let c = command.trim();
  for (;;) {
    const next = c.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "").replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
    if (next === c) break;
    c = next;
  }
  const word = c.split(/\s+/)[0] ?? "";
  return (word.split("/").pop() || word || "(empty)").slice(0, 40);
}

async function scan(file: string, since: number, use: BashUse): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"toolCall"')) continue;
    let msg: { timestamp?: string; message?: { role?: string; content?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(msg.timestamp ?? "");
    if (msg.message?.role !== "assistant" || !Array.isArray(msg.message.content) || !(ts >= since)) continue;
    for (const part of msg.message.content as { type?: string; name?: string; arguments?: { command?: unknown } }[]) {
      if (part?.type !== "toolCall") continue;
      use.toolCalls++;
      if (part.name !== "bash") continue;
      use.bashCalls++;
      const w = firstWord(typeof part.arguments?.command === "string" ? part.arguments.command : "");
      use.commands[w] = (use.commands[w] ?? 0) + 1;
      if (msg.timestamp! > use.last) use.last = msg.timestamp!;
    }
  }
}

/** `agent` is an id (kinwork-lead), or a role (lead) for every <ship>-lead. Agents with no calls in the window are listed with zeros. */
export async function bashUse(opts: { days: number; agent?: string; now?: number; inbox?: string }): Promise<BashUse[]> {
  const inbox = opts.inbox ?? fleetInboxRoot();
  const since = (opts.now ?? Date.now()) - opts.days * 86_400_000;
  const out: BashUse[] = [];
  for (const agent of readdirSync(inbox).sort()) {
    if (opts.agent && agent !== opts.agent && !agent.endsWith(`-${opts.agent}`)) continue;
    const dir = join(inbox, agent, "sessions");
    if (!existsSync(dir)) continue;
    const use: BashUse = { agent, toolCalls: 0, bashCalls: 0, commands: {}, last: "" };
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      const file = join(dir, f);
      // A file not written since the window opened has no call inside it.
      if (statSync(file).mtimeMs < since) continue;
      await scan(file, since, use);
    }
    out.push(use);
  }
  return out;
}

/** The rows `bin/fleet-axi bash-use` prints: busiest first, the top commands as `git 12, ls 4`. */
export function bashUseRows(rows: BashUse[], top = 6): Record<string, unknown>[] {
  return [...rows]
    .sort((a, b) => b.bashCalls - a.bashCalls || a.agent.localeCompare(b.agent))
    .map((r) => ({
      agent: r.agent,
      bash: r.bashCalls,
      tool_calls: r.toolCalls,
      last_bash: r.last,
      commands: Object.entries(r.commands).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([w, n]) => `${w} ${n}`).join(", "),
    }));
}
