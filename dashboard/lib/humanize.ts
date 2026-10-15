/**
 * Server-side twins of public/md.js's humanizeError, for HTML the server
 * renders (ship log rows): provider errors as one sentence, markdown symbols
 * dropped from one-line summaries.
 */

/** "402: This request requires more credits." from a provider error body. */
export function humanizeError(text: string): string {
  const raw = String(text ?? "").trim();
  let summary = raw.split("\n")[0] ?? "";
  const brace = raw.indexOf("{");
  if (brace >= 0) {
    const head = raw.slice(0, brace).trim();
    const status = head.match(/(?:^|\s)(\d{3})$/)?.[1];
    try {
      const j = JSON.parse(raw.slice(brace)) as { error?: { message?: unknown } | string; message?: unknown };
      let msg: unknown = typeof j.error === "object" ? j.error?.message : (j.message ?? j.error);
      if (typeof msg === "string") {
        const inner = msg.indexOf("{");
        if (inner >= 0) {
          try {
            const k = JSON.parse(msg.slice(inner)) as { error?: { message?: string }; message?: string };
            msg = k.error?.message ?? k.message ?? msg;
          } catch {
            /* keep msg */
          }
        }
        const lead = head.replace(/\s*\d{3}$/, "").trim();
        summary = `${lead ? `${lead} ` : ""}${status ? `${status}: ` : ""}${msg}`;
      }
    } catch {
      /* not JSON */
    }
  }
  if (/Could not parse .*SSE event|Unexpected end of JSON input/i.test(raw)) return "The model's connection dropped mid-reply.";
  return summary;
}

/** One-line summary without markdown punctuation. */
export function plainSummary(text: string): string {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/\s+/g, " ")
    .trim();
}
