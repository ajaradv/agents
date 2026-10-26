import { addQueueItem, readQueue, updateQueueItem } from "./decision-queue.ts";
import { checkSpec, setSpecStatus } from "./specs.ts";
import { busPost } from "./bus-api.ts";

/**
 * The flagship officers' side of the decision queue (extensions/decisions.ts):
 * the architect submits a drafted spec for the captain's review, and the
 * designer reports a voyage whose screenshots differ from the approved design.
 * Each call comes from a live session's token (the node checks who it is).
 */

type Res = { ok: boolean; message: string };

/** The architect hands a drafted spec to the captain: the queue's spec review gets the file. */
export function specSubmit(from: string, b: { queue?: unknown; path?: unknown }): Res {
  if (from !== "architect") return { ok: false, message: "Only the fleet's architect submits specs." };
  const id = String(b.queue ?? "");
  const item = readQueue().find((i) => i.id === id);
  if (!item || item.kind !== "spec-review") return { ok: false, message: "Name the spec review's queue id (from the spec-request on your bus)." };
  if (item.status !== "queued") return { ok: false, message: `That review is ${item.status}.` };
  const checked = checkSpec(String(b.path ?? ""), item.ship);
  if (!checked.ok) return checked;
  updateQueueItem(id, { record: checked.spec.file, note: "" });
  return { ok: true, message: `Submitted for the captain's review: ${checked.spec.title} (${checked.spec.criteria.length} acceptance criteria). It waits on the flagship's Decision queue; changes come back on your bus.` };
}

/** The designer's verdict on a voyage's screenshots against the approved design; only a difference reaches the queue. */
export function designReview(from: string, b: { ship?: unknown; verdict?: unknown; notes?: unknown; ref?: unknown }): Res {
  if (from !== "designer") return { ok: false, message: "Only the fleet's designer files design reviews." };
  const ship = String(b.ship ?? "");
  const notes = String(b.notes ?? "").trim();
  if (b.verdict === "matches") return { ok: true, message: `Recorded: ${ship}'s voyage matches the design. Nothing goes to the captain's queue.` };
  if (b.verdict !== "differs") return { ok: false, message: "verdict is matches or differs." };
  if (notes.length < 10) return { ok: false, message: "Say what differs (each difference, where, and what the design calls for)." };
  const r = addQueueItem({ kind: "design-review", ship, title: `Design review: ${ship}'s voyage differs from the design`, request: notes, by: from, source: String(b.ref ?? "") });
  return r.ok ? { ok: true, message: "On the captain's Decision queue as a design review." } : r;
}

/**
 * The captain's answer on a review. Spec review: approve marks the spec approved (a voyage can sail from it);
 * changes go back to the architect's bus. Design review: approve accepts the voyage as built; changes go to the
 * ship's lead to fix before docking.
 */
export async function reviewQueueItem(id: string, act: "approve" | "changes", note: string, deps: { tellLead: (to: string, text: string) => Promise<void> }): Promise<Res> {
  const item = readQueue().find((i) => i.id === id);
  if (!item || item.status !== "queued") return { ok: false, message: "That item is not waiting for a review." };
  const clean = note.trim().slice(0, 2000);
  if (item.kind === "spec-review") {
    if (!item.record) return { ok: false, message: "The architect has not submitted the spec yet." };
    if (act === "approve") {
      setSpecStatus(item.record, "approved");
      updateQueueItem(id, { status: "done" });
      return { ok: true, message: "Spec approved: a voyage can sail from it." };
    }
    if (clean.length < 5) return { ok: false, message: "Say what to change." };
    const posted = await busPost("captain", { to: "architect", kind: "spec-changes", summary: `Changes to the spec (queue ${id}): ${clean}`, ref: item.record, ship: item.ship }, async (a) => a === "architect");
    if (!posted.ok) return posted;
    updateQueueItem(id, { note: clean, record: "" });
    return { ok: true, message: "Sent to the architect; the revised spec comes back to the queue." };
  }
  if (item.kind === "design-review") {
    if (act === "approve") {
      updateQueueItem(id, { status: "done" });
      return { ok: true, message: "Accepted as built." };
    }
    await deps.tellLead(`${item.ship}-lead`, `The captain wants these design differences fixed before docking (design review ${id}):\n\n${item.request}${clean ? `\n\nThe captain adds: ${clean}` : ""}\n\nFix them, run the gates, then ask to dock again.`);
    updateQueueItem(id, { status: "done", note: clean });
    return { ok: true, message: `Sent to ${item.ship}-lead to fix before docking.` };
  }
  return { ok: false, message: "Only spec and design reviews take approve or changes." };
}
