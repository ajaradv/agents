/**
 * Requests from other web pages.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not other pages in the
 * captain's browser: any site can open a WebSocket to localhost or send a
 * "simple" cross-site POST, and agents here run with --approve. So:
 *
 * - the Host must be this dashboard (blocks DNS rebinding, where an outside
 *   name resolves to 127.0.0.1);
 * - WebSocket upgrades and anything but GET/HEAD/OPTIONS must come from the
 *   dashboard's own pages when a browser says where it came from (Origin,
 *   Sec-Fetch-Site). Agents, extensions, and curl send neither and pass.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requestRefusal(req: Request, port: number): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (host && !hosts.includes(host)) return "unknown host";

  const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  if (!upgrade && SAFE_METHODS.has(req.method)) return null;

  const origin = req.headers.get("origin");
  if (origin !== null && !hosts.some((h) => origin === `http://${h}`)) return "cross-origin request";
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "cross-site request";
  return null;
}
