const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** A ULID: 48-bit ms timestamp + 80 random bits, 26 characters, sorts by time (not monotonic within a ms). */
export function ulid(ms = Date.now()): string {
  let t = "";
  for (let n = ms, i = 0; i < 10; i++, n = Math.floor(n / 32)) t = ALPHABET[n % 32] + t;
  const r = crypto.getRandomValues(new Uint8Array(16)); // 16 bytes -> 16 chars of 5 random bits each (80 bits)
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ALPHABET[r[i]! & 31];
  return t + tail;
}

/** An event_key a sender may use: a ULID, or any short key of letters, digits, : _ - (the sender's own scheme). */
export const validEventKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= 80 && /^[A-Za-z0-9:_-]+$/.test(k);
