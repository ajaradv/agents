/**
 * Image window — send only the newest screenshots to the model.
 *
 * A designer reads screenshots all session long, and every turn re-sends every
 * image still in the transcript: one Kinwork session reached 52 images (86 MB),
 * past the provider's 32 MB request limit, and paid for all of them each turn.
 * Before each model call this keeps the newest images (by count and by size)
 * and swaps older ones for a one-line note. The session file is untouched, so
 * nothing is lost; the agent can re-read a file if it needs the picture again.
 *
 * Tune with FLEET_IMAGE_KEEP (earlier-turn count, default 6) and FLEET_IMAGE_MB
 * (total cap, default 20; providers refuse requests over 32 MB).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const KEEP = Math.max(0, Number(process.env.FLEET_IMAGE_KEEP ?? 6) || 0);
const MAX_BYTES = Math.max(1, Number(process.env.FLEET_IMAGE_MB ?? 20) || 20) * 1_000_000;
const NOTE = "[Image from an earlier turn left out to keep requests small. You saw it then; rely on what you concluded, and re-read it only if a decision now depends on it.]";

type Block = { type: string; data?: string; text?: string };
type Msg = { role?: string; content?: string | Block[] };

/**
 * Drop older images; returns null when nothing changes.
 *
 * Images since the captain's last message (this turn) are all kept, up to the
 * byte cap: dropping one mid-task made an agent re-read screenshots in a loop
 * (2026-10-14). From earlier turns, only the newest `keep` images stay.
 */
export function windowImages<T extends Msg>(messages: T[], keep = KEEP, maxBytes = MAX_BYTES): T[] | null {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  let kept = 0;
  let bytes = 0;
  let changed = false;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (!Array.isArray(m.content) || !m.content.some((b) => b?.type === "image")) continue;
    const thisTurn = i >= lastUser;
    let dropped = false;
    const content: Block[] = [];
    // Newest last within a message too: walk it backwards, then restore order.
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j]!;
      if (b?.type !== "image") {
        content.unshift(b);
        continue;
      }
      const size = b.data?.length ?? 0;
      if ((thisTurn || kept < keep) && bytes + size <= maxBytes) {
        if (!thisTurn) kept += 1;
        bytes += size;
        content.unshift(b);
      } else {
        dropped = true;
        content.unshift({ type: "text", text: NOTE });
      }
    }
    if (dropped) {
      out[i] = { ...m, content };
      changed = true;
    }
  }
  return changed ? out : null;
}

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event) => {
    const messages = windowImages(event.messages as Msg[]);
    return messages ? { messages: messages as typeof event.messages } : undefined;
  });
}
