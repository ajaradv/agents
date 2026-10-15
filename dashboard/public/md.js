/*
 * Chat text helpers (no dependencies, loaded before app.js).
 *
 * renderMarkdown: the subset agents actually write (paragraphs, headings,
 * lists, tables, code, quotes, bold/italic, links). Everything is HTML-escaped
 * first and only known constructs are turned back into tags, so agent text can
 * never inject markup; links must be http(s).
 *
 * humanizeError / formatDuration: provider errors and millisecond counts in a
 * form the captain can read, with the raw text kept for a fold.
 */
(function (root) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(text, codes) {
    let s = text;
    // [label](https://…) and bare URLs; the text is already escaped.
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|\s)_([^_\n]+?)_(?=\s|$|[.,;:!?])/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function table(lines, codes) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = cells(lines[0]);
    const body = lines.slice(2).map(cells);
    return `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, codes)}</th>`).join("")}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c, codes)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
  }

  function renderMarkdown(src) {
    const codes = [];
    const blocks = [];
    let text = esc(String(src ?? "").replace(/\r\n?/g, "\n"));
    // Fenced code first, so nothing inside it is touched.
    text = text.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, body) => {
      blocks.push(`<pre><code>${body.replace(/\n$/, "")}</code></pre>`);
      return `\n\n\u0001${blocks.length - 1}\u0001\n\n`;
    });
    text = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    const out = [];
    for (const chunk of text.split(/\n{2,}/)) {
      const block = chunk.replace(/^\n+|\n+$/g, "");
      if (!block.trim()) continue;
      const pre = block.match(/^\u0001(\d+)\u0001$/);
      if (pre) {
        out.push(blocks[Number(pre[1])]);
        continue;
      }
      const lines = block.split("\n");
      if (lines.length >= 2 && /^\s*\|.*\|\s*$/.test(lines[0]) && /^\s*\|?\s*:?-{2,}/.test(lines[1])) {
        out.push(table(lines, codes));
        continue;
      }
      const h = block.match(/^(#{1,6})\s+(.+)$/);
      if (h && lines.length === 1) {
        out.push(h[1].length <= 2 ? `<h4>${inline(h[2], codes)}</h4>` : `<h5>${inline(h[2], codes)}</h5>`);
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(block)) {
        out.push("<hr />");
        continue;
      }
      if (lines.every((l) => /^&gt;\s?/.test(l))) {
        out.push(`<blockquote>${inline(lines.map((l) => l.replace(/^&gt;\s?/, "")).join("<br />"), codes)}</blockquote>`);
        continue;
      }
      // Mixed blocks: text lines and list runs ("Changes:\n- a\n- b") without blank lines between.
      const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
      let para = [];
      let list = null;
      const flushPara = () => {
        if (!para.length) return;
        const lead = para[0].match(/^(#{1,6})\s+(.+)$/);
        if (lead) {
          out.push(`<h5>${inline(lead[2], codes)}</h5>`);
          para.shift();
        }
        if (para.length) out.push(`<p>${inline(para.join("<br />"), codes)}</p>`);
        para = [];
      };
      const flushList = () => {
        if (!list) return;
        out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, codes)}</li>`).join("")}</${list.tag}>`);
        list = null;
      };
      for (const l of lines) {
        const m = l.match(ITEM);
        if (m) {
          flushPara();
          const tag = /^\s*\d+[.)]\s+/.test(l) ? "ol" : "ul";
          if (list && list.tag !== tag) flushList();
          if (!list) list = { tag, items: [] };
          list.items.push(m[1]);
        } else if (list && /^\s{2,}\S/.test(l)) {
          list.items[list.items.length - 1] += " " + l.trim();
        } else {
          flushList();
          para.push(l);
        }
      }
      flushList();
      flushPara();
    }
    return out.join("");
  }

  /** "2m 52s" from milliseconds. */
  function formatDuration(ms) {
    const n = Number(ms) || 0;
    if (n < 1000) return `${Math.round(n)}ms`;
    const s = Math.round(n / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // A provider stream cut off mid-event (the agent host retries these twice).
  const STREAM_DROPPED = /Could not parse .*SSE event|Unexpected end of JSON input/i;

  /**
   * Provider and harness errors → one readable sentence plus the raw text.
   * Handles JSON error bodies ({"error":{"message":…}}), "402 {…}" prefixes,
   * and multi-line Pi errors (first line only).
   */
  function humanizeError(text) {
    const raw = String(text ?? "").trim();
    let summary = raw.split("\n")[0];
    const brace = raw.indexOf("{");
    if (brace >= 0) {
      const status = raw.slice(0, brace).trim().match(/^\d{3}$/)?.[0];
      try {
        const j = JSON.parse(raw.slice(brace));
        let msg = j?.error?.message ?? j?.message ?? j?.error;
        if (typeof msg === "string") {
          // Nested JSON inside the message (bridges wrap upstream errors).
          const inner = msg.indexOf("{");
          if (inner >= 0) {
            try {
              const k = JSON.parse(msg.slice(inner));
              msg = k?.error?.message ?? k?.message ?? msg;
            } catch {
              /* keep msg */
            }
          }
          summary = (status ? `${status}: ` : "") + msg;
        }
      } catch {
        /* not JSON; keep the first line */
      }
    }
    if (STREAM_DROPPED.test(raw)) summary = "The model's connection dropped mid-reply.";
    if (summary.length > 220) summary = summary.slice(0, 217) + "…";
    return { summary, raw, folded: raw !== summary };
  }

  /**
   * The next speakable piece of a reply that is still streaming: everything
   * from `from` up to the last finished sentence (or line), when that is at
   * least `min` characters and not inside an open code fence. Returns
   * {chunk, next} or null to wait for more text. With `final`, the rest of the
   * text goes out whatever its length.
   */
  function speechChunk(text, from, min = 40, final = false) {
    const rest = String(text).slice(from);
    if (final) return rest.trim() ? { chunk: rest, next: text.length } : null;
    const fences = (s) => (s.match(/```/g) || []).length;
    let end = -1;
    const re = /[.!?:;](?=\s)|\n/g;
    let m;
    while ((m = re.exec(rest))) {
      const cut = m.index + m[0].length;
      if (fences(text.slice(0, from + cut)) % 2 === 0) end = cut;
    }
    if (end < 0 || rest.slice(0, end).trim().length < min) return null;
    return { chunk: rest.slice(0, end), next: from + end };
  }

  /**
   * How much of a reply to say out loud: the opening, up to the first list,
   * table, heading, or code block, and at most about `budget` characters
   * (cut at a sentence end, always at least the first sentence). Long or
   * structured replies are read on screen; voice gives the gist.
   * Returns {limit, cut}: speak text.slice(0, limit); cut means more follows.
   */
  function spokenLimit(text, budget = 350, final = true) {
    const t = String(text);
    const structure = t.search(/\n[ \t]*([-*+][ \t]|\d+[.)][ \t]|\||#{1,6}[ \t]|```)/);
    let limit = structure < 0 ? t.length : structure;
    if (limit > budget) {
      const ends = [...t.slice(0, limit).matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index + 1);
      // Still streaming and no sentence has ended yet: wait rather than cut mid-sentence.
      if (!final && !ends.length) return { limit: t.length, cut: false };
      const within = ends.filter((e) => e <= budget);
      limit = within.length ? within[within.length - 1] : ends.length ? ends[0] : Math.min(limit, budget);
    }
    return { limit, cut: t.slice(limit).trim().length > 0 };
  }

  root.renderMarkdown = renderMarkdown;
  root.spokenLimit = spokenLimit;
  root.speechChunk = speechChunk;
  root.formatDuration = formatDuration;
  root.humanizeError = humanizeError;
})(typeof window !== "undefined" ? window : globalThis);
