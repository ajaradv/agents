/**
 * decisions: the flagship officers' side of the captain's decision queue
 * (dashboard/lib/decisions.ts; vault plan fleet/plans/feature/design-sessions).
 *
 * - spec_submit (architect): hand a drafted spec to the captain's review.
 * - plan_check (architect): a plan's execution block bound to the crew-dispatch
 *   rules (what `bun bin/plan-execution.ts <plan>` printed), for the Architect without bash.
 * - design_review (designer): a voyage's screenshots against the approved
 *   design; only a difference reaches the queue.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const base = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
const token = process.env.FLEET_CREW_TOKEN ?? "";
const agent = process.env.FLEET_AGENT_ID ?? "";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

async function call(what: "spec" | "design-review" | "plan-check", body: Record<string, unknown>): Promise<string> {
  if (!base || !token) return "Decision tools work only in a live dashboard session. Tell the captain in chat instead.";
  try {
    const res = await fetch(`${base}/api/decisions/${what}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fleet-crew-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return String(((await res.json()) as { message?: string }).message ?? (res.ok ? "done" : "failed"));
  } catch (e) {
    return `The fleet node did not answer (${e instanceof Error ? e.message : String(e)}). Tell the captain.`;
  }
}

export default function (pi: ExtensionAPI) {
  if (agent !== "designer") {
    pi.registerTool({
      name: "spec_submit",
      label: "Submit a spec for the captain's review",
      description:
        "Architect: after writing a spec to the vault (fleet/specs/<ship>/<slug>.md, with frontmatter title, ship, status: draft, source, prototype, and a '## Acceptance criteria' list of checkable items), hand it to the captain's Decision queue. Use the queue id from the spec-request on your bus. The captain approves it or sends changes back to your bus.",
      parameters: Type.Object({
        queue: Type.String({ description: "The spec review's queue id (q...), from the spec-request" }),
        path: Type.String({ description: "The spec's vault path, e.g. fleet/specs/kinwork/search-page.md" }),
      }),
      async execute(_id, p) {
        return text(await call("spec", { queue: p.queue, path: p.path }));
      },
    });
    pi.registerTool({
      name: "plan_check",
      label: "Check a plan's execution block",
      description:
        "Architect: check a plan's `execution:` block before you move it to reviewed. Gives each task's rule and the profiles it resolves to, or the errors (malformed block, unknown rule id) as TOON. path is the plan's vault path, e.g. fleet/plans/feature/r4-crew-isolation.md; only notes inside the vault.",
      parameters: Type.Object({ path: Type.String({ description: "The plan's vault path" }) }),
      async execute(_id, p) {
        return text(await call("plan-check", { path: p.path }));
      },
    });
  }
  if (agent !== "architect") {
    pi.registerTool({
      name: "design_review",
      label: "Review a voyage against the design",
      description:
        "Designer: when a voyage built from your design asks to dock, compare its screenshots with the approved design brief. matches: nothing goes to the captain. differs: list each difference, where it is, and what the design calls for; it goes on the captain's Decision queue.",
      parameters: Type.Object({
        ship: Type.String({ description: "The ship whose voyage you reviewed" }),
        verdict: StringEnum(["matches", "differs"] as const),
        notes: Type.Optional(Type.String({ description: "The differences (required for differs)" })),
        ref: Type.Optional(Type.String({ description: "The voyage record or the spec path" })),
      }),
      async execute(_id, p) {
        return text(await call("design-review", { ship: p.ship, verdict: p.verdict, notes: p.notes ?? "", ref: p.ref ?? "" }));
      },
    });
  }
}
