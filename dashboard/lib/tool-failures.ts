import { journalDb } from "./journal.ts";
import { jevAsk } from "./jev.ts";
import { redact } from "./redact.ts";
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
  tool TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', error TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  noise INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tool_failures_ts ON tool_failures(ts);
CREATE TABLE IF NOT EXISTS tool_failure_notices (key TEXT PRIMARY KEY, day TEXT NOT NULL);
`;

// Per handle: the journal can be reopened at another path (tests do).
const migrated = new WeakSet<object>();
function db() {
  const d = journalDb();
  d.exec(SCHEMA);
  if (!migrated.has(d)) {
    // Added later: failures that are really a "no" answer (grep with no match), kept but not counted.
    const cols = d.query("PRAGMA table_info(tool_failures)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "noise")) d.exec("ALTER TABLE tool_failures ADD COLUMN noise INTEGER NOT NULL DEFAULT 0");
    migrated.add(d);
  }
  return d;
}

/** Commands whose exit 1 means "no" (no match, test false, files differ), not a failure. */
const ANSWERS_NO = /^(grep|egrep|fgrep|rg|ag|test|\[\[?|diff|cmp|which|command\s+-v|type|git\s+(grep|diff\s+--(quiet|exit-code))|pgrep|lsof|fd)\b/;

/**
 * A failed bash call that is really an answer (vault task fleet-jev-system-one,
 * noise filter): the pipeline's last command is a search or test and it exited 1
 * with nothing that looks like an error. Code decides these; Jev looks at the rest.
 */
export function expectedFailure(tool: string, args: string, error: string): boolean {
  if (tool !== "bash" || !/exited with code 1\b/.test(error)) return false;
  const cmd = args.replace(/^bash:\s*/, "").replace(/\s*;\s*$/, "");
  const last = cmd.split(/\|\||&&|;|\|/).map((x) => x.trim()).filter(Boolean).at(-1) ?? "";
  if (!ANSWERS_NO.test(last.replace(/^(\w+=\S*\s+)+/, ""))) return false;
  return !/\b(error|fatal|permission denied|no such file|not found|cannot|failed)\b/i.test(error.replace(/Command exited with code 1/, ""));
}

/** A failure repeated this often within an hour, for one agent and tool, is worth a notice. */
const REPEAT_NOTICE = 3;

export type ToolFailure = { id: number; ts: string; agent: string; tool: string; args: string; error: string; model: string };

/** "turn" as the tool: the whole turn died (a provider error), not one call. */
export function recordToolFailure(f: { agent: string; tool: string; args?: string; error: string; model?: string }, judge: (id: number, f: { tool: string; args: string; error: string }) => void = judgeLater): void {
  const d = db();
  const ts = new Date().toISOString();
  const error = f.error.replace(/\s+/g, " ").trim().slice(0, 600) || "(no error text)";
  const args = (f.args ?? "").slice(0, 300);
  const noise = expectedFailure(f.tool, args, error) ? 1 : 0;
  const row = d.query("INSERT INTO tool_failures (ts, agent, tool, args, error, model, noise) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").get(ts, f.agent, f.tool, args, error, (f.model ?? "").slice(0, 120), noise) as { id: number };
  if (noise) return;
  // Other bash failures: Jev decides in the background whether it was an expected non-zero exit.
  if (f.tool === "bash") judge(row.id, { tool: f.tool, args, error });
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const n = (d.query("SELECT COUNT(*) AS n FROM tool_failures WHERE agent = ? AND tool = ? AND ts >= ? AND noise = 0").get(f.agent, f.tool, hour) as { n: number }).n;
  if (n < REPEAT_NOTICE) return;
  const key = `${f.agent}\u0000${f.tool}`;
  const day = ts.slice(0, 10);
  const seen = d.query("SELECT day FROM tool_failure_notices WHERE key = ?").get(key) as { day: string } | null;
  if (seen?.day === day) return;
  d.query("INSERT INTO tool_failure_notices (key, day) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET day = excluded.day").run(key, day);
  const what = f.tool === "turn" ? "turns ended on provider errors" : `${f.tool} failed`;
  notifyCaptain({ from: f.agent, kind: "info", summary: `${f.agent}: ${what} ${n} times in the last hour. Latest: ${error.slice(0, 160)}`, ref: "Health, tool failures" });
}

/** Jev, in the background: was this failed bash call an expected non-zero exit? Marked noise when sure. */
function judgeLater(id: number, f: { tool: string; args: string; error: string }): void {
  void jevAsk("failure-noise", { command: redact(f.args).slice(0, 400), output: redact(f.error).slice(0, 1500) }, {
    expected: {
      type: "noul",
      instructions: "An AI agent's shell command exited non-zero. Was that an expected answer rather than a problem: a search that found nothing, a test or comparison that answered no, a probe for something optional that is absent?",
      criteria: { true: "The command worked and its non-zero exit is the answer (no match, false, differs, not present)", false: "Something went wrong: an error message, a missing file or tool that was needed, a failed build, test, or commit" },
    },
  })
    .then((r) => {
      const a = r.ok ? r.answers.expected : undefined;
      if (a && a.type === "noul" && a.noul >= 0.8) db().query("UPDATE tool_failures SET noise = 1 WHERE id = ?").run(id);
    })
    .catch(() => {});
}

export function recentToolFailures(limit = 10): ToolFailure[] {
  return db().query("SELECT * FROM tool_failures WHERE noise = 0 ORDER BY id DESC LIMIT ?").all(limit) as ToolFailure[];
}

/** Failures per agent and tool since `hours` ago, most first. */
export function toolFailureCounts(hours = 24): { agent: string; tool: string; n: number; last: string }[] {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db()
    .query("SELECT agent, tool, COUNT(*) AS n, MAX(ts) AS last FROM tool_failures WHERE ts >= ? AND noise = 0 GROUP BY agent, tool ORDER BY n DESC, last DESC")
    .all(since) as { agent: string; tool: string; n: number; last: string }[];
}

/** The newest counted failures since an ISO time, with their errors (fleet_query tool_failures). */
export function toolFailuresSince(since: string, limit = 8): ToolFailure[] {
  return db().query("SELECT * FROM tool_failures WHERE ts >= ? AND noise = 0 ORDER BY id DESC LIMIT ?").all(since, limit) as ToolFailure[];
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
