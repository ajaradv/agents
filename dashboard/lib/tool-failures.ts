import { journalDb } from "./journal.ts";
import { escapeHtml } from "./quota.ts";
import { notifyCaptain } from "./notify.ts";

/**
 * The tool failure log: every failed tool call of a live agent, and every
 * turn that died on a provider error, in one table in the journal's database.
 * Agents used to mention failures only in their chat ("the image viewer is
 * failing"), where nobody could count them. The agent host records them;
 * Health shows the last day; a tool that keeps failing for one agent raises
 * one notice (for the digest), not one per failure.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent TEXT NOT NULL,
  tool TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', error TEXT NOT NULL, model TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tool_failures_ts ON tool_failures(ts);
CREATE TABLE IF NOT EXISTS tool_failure_notices (key TEXT PRIMARY KEY, day TEXT NOT NULL);
`;

function db() {
  const d = journalDb();
  d.exec(SCHEMA);
  return d;
}

/** A failure repeated this often within an hour, for one agent and tool, is worth a notice. */
const REPEAT_NOTICE = 3;

export type ToolFailure = { id: number; ts: string; agent: string; tool: string; args: string; error: string; model: string };

/** "turn" as the tool: the whole turn died (a provider error), not one call. */
export function recordToolFailure(f: { agent: string; tool: string; args?: string; error: string; model?: string }): void {
  const d = db();
  const ts = new Date().toISOString();
  const error = f.error.replace(/\s+/g, " ").trim().slice(0, 600) || "(no error text)";
  d.query("INSERT INTO tool_failures (ts, agent, tool, args, error, model) VALUES (?, ?, ?, ?, ?, ?)").run(ts, f.agent, f.tool, (f.args ?? "").slice(0, 300), error, (f.model ?? "").slice(0, 120));
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const n = (d.query("SELECT COUNT(*) AS n FROM tool_failures WHERE agent = ? AND tool = ? AND ts >= ?").get(f.agent, f.tool, hour) as { n: number }).n;
  if (n < REPEAT_NOTICE) return;
  const key = `${f.agent}\u0000${f.tool}`;
  const day = ts.slice(0, 10);
  const seen = d.query("SELECT day FROM tool_failure_notices WHERE key = ?").get(key) as { day: string } | null;
  if (seen?.day === day) return;
  d.query("INSERT INTO tool_failure_notices (key, day) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET day = excluded.day").run(key, day);
  const what = f.tool === "turn" ? "turns ended on provider errors" : `${f.tool} failed`;
  notifyCaptain({ from: f.agent, kind: "info", summary: `${f.agent}: ${what} ${n} times in the last hour. Latest: ${error.slice(0, 160)}`, ref: "Health, tool failures" });
}

export function recentToolFailures(limit = 10): ToolFailure[] {
  return db().query("SELECT * FROM tool_failures ORDER BY id DESC LIMIT ?").all(limit) as ToolFailure[];
}

/** Failures per agent and tool since `hours` ago, most first. */
export function toolFailureCounts(hours = 24): { agent: string; tool: string; n: number; last: string }[] {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db()
    .query("SELECT agent, tool, COUNT(*) AS n, MAX(ts) AS last FROM tool_failures WHERE ts >= ? GROUP BY agent, tool ORDER BY n DESC, last DESC")
    .all(since) as { agent: string; tool: string; n: number; last: string }[];
}

const time = (ts: string) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Health: the last day's failures, folded when there are none. */
export function toolFailuresHtml(): string {
  const counts = toolFailureCounts(24);
  const total = counts.reduce((s, c) => s + c.n, 0);
  if (!total) return `<details class="fold"><summary>Tool failures · none in 24h</summary><p class="muted">Failed tool calls and turns that died on provider errors show up here.</p></details>`;
  const rows = counts
    .slice(0, 12)
    .map((c) => `<tr><td>${escapeHtml(c.agent)}</td><td>${escapeHtml(c.tool)}</td><td>${c.n}</td><td>${escapeHtml(time(c.last))}</td></tr>`)
    .join("");
  const recent = recentToolFailures(8)
    .map(
      (f) =>
        `<li><b>${escapeHtml(f.agent)}</b> · ${escapeHtml(f.tool)}${f.args ? ` <span class="muted">${escapeHtml(f.args.slice(0, 80))}</span>` : ""} · ${escapeHtml(time(f.ts))}${f.model ? ` <span class="muted">(${escapeHtml(f.model)})</span>` : ""}<br><span class="muted">${escapeHtml(f.error.slice(0, 220))}</span></li>`,
    )
    .join("");
  return `<details class="fold" open><summary>Tool failures · ${total} in 24h</summary><table class="spend-table"><thead><tr><th>Agent</th><th>Tool</th><th>Failures</th><th>Last</th></tr></thead><tbody>${rows}</tbody></table><h3>Latest</h3><ul class="fail-list">${recent}</ul></details>`;
}
