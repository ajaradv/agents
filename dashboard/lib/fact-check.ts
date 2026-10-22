import { readVaultTasks, type VaultTask } from "./vault-tasks.ts";

/**
 * A deterministic check on Alice's answers about vault tasks. On 2026-10-19
 * the captain asked by voice which task to pick up next; Alice answered in two
 * seconds, with no tool call, from a list still in her session, and named
 * `fleet-tool-failure-log`, done since 2026-10-16. Her role already says to
 * look before answering; a short question ("in one sentence") beat it.
 *
 * So: when a turn names a vault task that is done or dropped, and the agent
 * did not look at the vault in that turn, it gets one note to check and
 * correct itself. Cheap (no model), and silent when it looked.
 */

/** Tool activity that counts as looking at the vault's tasks. */
const LOOKED = /\b(vault_tasks|fleet_status)\b|\/tasks\/[\w-]+\.md|tasks-axi|obsidian/;

export function looksAtVault(activity: string): boolean {
  return LOOKED.test(activity);
}

/** Task ids the text names (as `id`, [[id]], or a bare id with a hyphen), that are done or dropped. */
export function staleTaskMentions(text: string, tasks: VaultTask[]): VaultTask[] {
  const closed = tasks.filter((t) => /^(done|dropped|cancelled|canceled)$/i.test(t.status) && t.id.includes("-"));
  return closed.filter((t) => new RegExp(`(^|[^\\w-])${t.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text));
}

/** It says the task is finished itself: nothing to correct. */
function saysClosed(text: string, id: string): boolean {
  const i = text.indexOf(id);
  const near = text.slice(Math.max(0, i - 80), i + id.length + 80);
  return /\b(done|finished|completed|closed|shipped|landed|already)\b/i.test(near);
}

type Turn = { looked: boolean; said: string[] };
const turns = new Map<string, Turn>();

/** Agents whose answers are checked: Alice, who answers the captain's "what next" questions. */
export const CHECKED = new Set(["alice"]);

export function turnStarted(agentId: string): void {
  if (CHECKED.has(agentId)) turns.set(agentId, { looked: false, said: [] });
}

export function toolUsed(agentId: string, activity: string): void {
  const t = turns.get(agentId);
  if (t && looksAtVault(activity)) t.looked = true;
}

export function agentSaid(agentId: string, text: string): void {
  turns.get(agentId)?.said.push(text);
}

/** At the end of a turn: the note to send, or null. */
export function turnEnded(agentId: string, tasks: () => VaultTask[] = () => readVaultTasks().tasks): string | null {
  const t = turns.get(agentId);
  turns.delete(agentId);
  if (!t || t.looked || !t.said.length) return null;
  const text = t.said.join("\n");
  const stale = staleTaskMentions(text, tasks()).filter((s) => !saysClosed(text, s.id));
  if (!stale.length) return null;
  const list = stale.map((s) => `\`${s.id}\` (${s.status})`).join(", ");
  return `Fact check: your last answer names ${list}, but the vault says ${stale.length > 1 ? "they are" : "it is"} no longer open, and you did not look at the vault this turn. Call vault_tasks, then correct your answer to the captain in one or two lines. Answer vault questions from vault_tasks every time, not from earlier in this session.`;
}
