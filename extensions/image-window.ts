/**
 * Image window — send only the newest screenshots to the model.
 *
 * A designer reads screenshots all session long, and every turn re-sends every
 * image still in the transcript: one Kinwork session reached 52 images (86 MB),
 * past the provider's 32 MB request limit, and paid for all of them each turn.
 * Before each model call this keeps this turn's images and recent ones, and
 * swaps older ones for a one-line note, in batches so the prompt cache holds. The session file is untouched, so
 * nothing is lost; the agent can re-read a file if it needs the picture again.
 *
 * Tune with FLEET_IMAGE_KEEP (earlier-turn batch size, default 6) and FLEET_IMAGE_MB
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
 * (2026-10-14).
 *
 * Earlier-turn images are dropped in batches, oldest first, so the start of
 * the conversation changes rarely. A sliding window (always the newest 6)
 * edited an early message on every new screenshot and every new captain
 * message, which broke the provider's prefix cache each time. Now nothing is
 * dropped until there are 2×keep earlier images; then the oldest are dropped
 * in multiples of `keep`, so the dropped set (and the cached prefix) changes
 * once per `keep` new images. The byte cap also drops in batches of `keep`.
 */
export function windowImages<T extends Msg>(messages: T[], keep = KEEP, maxBytes = MAX_BYTES): T[] | null {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  // Every image, oldest first, with where it lives.
  const images: { i: number; j: number; size: number; thisTurn: boolean }[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((b, j) => {
      if (b?.type === "image") images.push({ i, j, size: b.data?.length ?? 0, thisTurn: i >= lastUser });
    });
  });
  const earlier = images.filter((x) => !x.thisTurn);
  const current = images.filter((x) => x.thisTurn);
  let dropEarlier = keep <= 0 ? earlier.length : earlier.length <= 2 * keep ? 0 : Math.floor((earlier.length - keep) / keep) * keep;
  const bytesKept = () => earlier.slice(dropEarlier).reduce((n, x) => n + x.size, 0) + current.reduce((n, x) => n + x.size, 0);
  while (dropEarlier < earlier.length && bytesKept() > maxBytes) dropEarlier = Math.min(earlier.length, dropEarlier + Math.max(1, keep));
  const drop = new Set(earlier.slice(0, dropEarlier).map((x) => `${x.i}:${x.j}`));
  // Still over the cap with this turn's images alone (rare): drop this turn's oldest one by one.
  let total = bytesKept();
  for (const x of current) {
    if (total <= maxBytes) break;
    drop.add(`${x.i}:${x.j}`);
    total -= x.size;
  }
  if (!drop.size) return null;
  const out = messages.slice();
  for (const key of new Set([...drop].map((k) => Number(k.split(":")[0])))) {
    const m = out[key]!;
    out[key] = { ...m, content: (m.content as Block[]).map((b, j) => (drop.has(`${key}:${j}`) ? { type: "text", text: NOTE } : b)) };
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event) => {
    const messages = windowImages(event.messages as Msg[]);
    return messages ? { messages: messages as typeof event.messages } : undefined;
  });
}
