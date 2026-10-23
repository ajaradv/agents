import { hostRunner, localHost } from "./ship-host.ts";

/**
 * A docked voyage lands through its ship's delivery mode (ported from
 * Firstmate; vault firstmate-deep-dive R3). Before, every dock left the branch
 * in the local repo whatever the ship said.
 *
 * - local-only: the branch stays local, ready for the captain to merge.
 * - direct-PR: push the branch and open a pull request.
 * - no-mistakes, no-mistakes-prod-only, no-mistakes-required: the same pull
 *   request, after the ship's dock gates passed (dockVoyage refuses a red dock);
 *   the gates stand in for the no-mistakes pipeline, which the hub does not run.
 *
 * Nothing is ever merged here: the captain merges, so a red branch never lands.
 * A failed push or PR never undoes the dock; the branch stays and the reason is
 * reported.
 */

export type Delivery = "local" | "pr";

export function deliveryFor(mode: string): Delivery {
  return mode === "direct-PR" || mode.startsWith("no-mistakes") ? "pr" : "local";
}

type Run = (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;

/** Push `branch` and open a PR onto `base`; the PR's URL, or why not. Runs on the ship host holding the repo (hostRunner). */
export async function openDockPr(
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  exec: Run = hostRunner(localHost),
): Promise<{ ok: boolean; url?: string; message: string }> {
  const push = await exec(["git", "push", "-u", "origin", branch], repo);
  if (push.code !== 0) return { ok: false, message: `the branch was not pushed (${push.out.split("\n").pop()?.slice(0, 160)}); it stays local` };
  const existing = await exec(["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"], repo);
  if (existing.code === 0 && /^https:\/\//.test(existing.out)) return { ok: true, url: existing.out.split("\n")[0], message: "a pull request for this branch was already open" };
  const pr = await exec(["gh", "pr", "create", "--head", branch, "--base", base, "--title", title.slice(0, 120), "--body", body.slice(0, 60_000)], repo);
  const url = pr.out.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
  if (pr.code !== 0 || !url) return { ok: false, message: `the branch is pushed but no pull request was opened (${pr.out.split("\n").pop()?.slice(0, 160)})` };
  return { ok: true, url, message: "pull request opened" };
}

/** A PR title from the voyage goal: its first sentence, without the vault-plan pointer. */
export function prTitle(goal: string): string {
  const first = goal.replace(/\s*\(vault plan[^)]*\)?/i, "").split(/(?<=[.!?])\s/)[0] ?? goal;
  return first.replace(/[.\s]+$/, "").slice(0, 100);
}
