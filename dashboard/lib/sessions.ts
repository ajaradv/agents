/**
 * Design and spec sessions (vault plan fleet/plans/feature/design-sessions):
 * the captain decides with the flagship's one designer (looks) or architect
 * (specs), before any voyage builds anything. A session reuses the voyage
 * machinery with `kind: session`: a leased worktree on the laptop with the
 * ship's rigged stack, the officer launched into it as the ship's guest, a
 * decision log in the voyage scratchpad, and a wrap-up instead of a dock:
 * no gates, no pull request, the prototype branch pushed for a later voyage
 * to start from, and the brief written into the session's record.
 */

export const SESSION_KINDS = { design: "designer", spec: "architect" } as const;
export type SessionKind = keyof typeof SESSION_KINDS;

export function sessionKindOf(agentId: string): SessionKind | null {
  for (const [kind, agent] of Object.entries(SESSION_KINDS)) if (agent === agentId) return kind as SessionKind;
  return null;
}

/** The section the officer writes the outcome into, in the voyage scratchpad (archived at wrap-up). */
export const briefHeading = (kind: SessionKind) => (kind === "design" ? "Design brief" : "Spec brief");

/** The prototype branch: design/<slug> or spec/<slug>. */
export const sessionBranch = (kind: SessionKind, slug: string) => `${kind}/${slug}`;

/** The opening message the officer gets once the session's stack is ready. */
export function sessionBrief(o: { ship: string; kind: SessionKind; topic: string; record: string; branch: string }): string {
  const design = o.kind === "design";
  return [
    `New ${o.kind} session for ${o.ship}: ${o.topic}`,
    "",
    `Session record (vault): ${o.record}`,
    `You are working aboard ${o.ship} as the fleet's ${design ? "designer" : "architect"}, in the session's own worktree on branch ${o.branch} (the ship's repo, its DESIGN.md and PRODUCT.md). Nothing here is delivered: no pull request, no gates. The outcome is a decision and a brief; a later voyage builds it.`,
    "",
    "How the session runs:",
    `1. Kickoff: read the request and the current ${design ? "page on the running app" : "code"}; ask the captain one or two framing questions with ask_captain (what matters most, constraints); say what you will show first.`,
    design
      ? "2. Rounds: 3 to 5 options per round as one canvas image set with choose: true (desktop and phone shots, one line each on what it tries). Build prototypes behind a switch (for example ?variant=) so the default page stays untouched, and link the live preview. End every round with a question, never with a report."
      : "2. Rounds: lay out options (approaches, trade-offs, risks, rough cost) as a short canvas markdown table; prototype only to answer a question. End every round with a question, never with a report.",
    "3. The captain picks (canvas Pick or chat) or comments; the next round narrows. Never choose a direction yourself, and never polish an option the captain has not chosen.",
    `4. Keep a running decision log in the voyage scratchpad (what was shown, what the captain chose and why).`,
    `5. When the captain says this is the one: write the outcome under "## ${briefHeading(o.kind)}" in the scratchpad (${design ? "the chosen direction, the final screenshots' paths, tokens and components, decisions and why, what a voyage must build, open questions" : "goal, scope and non-goals, checkable acceptance criteria, technical approach, risks, rough task shape, open questions"}), commit the prototype on the branch, and call voyage_dock with a one-line summary. The captain's Go wraps the session up: the branch is pushed, the brief goes into the record, the stack comes down.`,
  ].join("\n");
}

/** The brief section out of the archived scratchpad (empty when the officer did not write one). */
export function extractBrief(scratch: string, kind: SessionKind): string {
  const m = scratch.match(new RegExp(`^##\\s+${briefHeading(kind)}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m"));
  return m?.[1]?.trim() ?? "";
}
