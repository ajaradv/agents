/** Shared by everything that sends text to Jev or logs it (tool-gate.ts, ship-checks.ts, the advisors). */

/** Obvious secrets out of anything sent to Jev or written to the log. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED KEY]")
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "[REDACTED]")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/g, "[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD))(\s*[=:]\s*)(["']?)[^\s"']{6,}\4/g, "$1$3[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
}
