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
 *
 * The phone (D6) comes through Tailscale Serve: Host is this Mac's tailnet name
 * (<name>.<tailnet>.ts.net) and Serve adds Tailscale-User-Login (it strips any
 * the client sent). Such a request is allowed when both are there; set
 * FLEET_TAILNET_USERS (comma-separated logins) to admit only those people.
 * A rebinding page cannot fake it: it cannot make a ts.net name point here.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requestRefusal(req: Request, port: number): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const origins = hosts.map((h) => `http://${h}`);
  if (host && !hosts.includes(host)) {
    // Serve on another port than 443 (the node's :8786, for crew on the laptop) keeps it in Host.
    const tailnet = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d{1,5})?$/.test(host);
    const login = (req.headers.get("tailscale-user-login") ?? "").toLowerCase();
    if (!tailnet || !login) return "unknown host";
    const allowed = (process.env.FLEET_TAILNET_USERS ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(login)) return `tailnet user ${login} not allowed`;
    origins.push(`https://${host}`);
  }

  const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  if (!upgrade && SAFE_METHODS.has(req.method)) return null;

  const origin = req.headers.get("origin");
  if (origin !== null && !origins.includes(origin)) return "cross-origin request";
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "cross-site request";
  return null;
}
