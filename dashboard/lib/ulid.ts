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
