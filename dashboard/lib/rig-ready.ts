/** The stylesheets a page links (absolute URLs), skipping print and disabled ones; bin/rig-ready probes each. */
export function stylesheetHrefs(html: string, base: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined);
    if (!/(^|\s)stylesheet(\s|$)/i.test(attr("rel") ?? "")) continue;
    if (/\bdisabled\b/i.test(tag) || attr("media") === "print") continue;
    const href = attr("href");
    if (!href) continue;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      /* not a URL */
    }
  }
  return out;
}
