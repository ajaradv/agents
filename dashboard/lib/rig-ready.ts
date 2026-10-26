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

/**
 * A request for `url` that works where `*.localhost` does not resolve (Linux without systemd-resolved, such
 * as the hub): sent to 127.0.0.1 with the original Host, which is all a local reverse proxy (Traefik) needs.
 */
export function loopbackRequest(url: string): { url: string; headers: Record<string, string> } {
  const u = new URL(url);
  if (!u.hostname.endsWith(".localhost")) return { url, headers: {} };
  const host = u.host;
  u.hostname = "127.0.0.1";
  return { url: u.toString(), headers: { Host: host } };
}
