import { afterEach, describe, expect, test } from "bun:test";
import { requestRefusal } from "./request-guard.ts";

const req = (headers: Record<string, string>, method = "GET") => new Request("http://127.0.0.1:8787/api/x", { method, headers });
const TS = "mac.tail1234.ts.net";

afterEach(() => delete process.env.FLEET_TAILNET_USERS);

describe("request guard", () => {
  test("localhost passes; an outside host (DNS rebinding) does not", () => {
    expect(requestRefusal(req({ host: "127.0.0.1:8787" }), 8787)).toBeNull();
    expect(requestRefusal(req({ host: "evil.example" }), 8787)).toBe("unknown host");
  });
  test("the tailnet name passes only with Tailscale Serve's identity header", () => {
    expect(requestRefusal(req({ host: TS }), 8787)).toBe("unknown host");
    expect(requestRefusal(req({ host: TS, "tailscale-user-login": "captain@example.com" }), 8787)).toBeNull();
    expect(requestRefusal(req({ host: "evil.example", "tailscale-user-login": "captain@example.com" }), 8787)).toBe("unknown host");
  });
  test("POSTs from the tailnet page pass; from another origin they do not", () => {
    const h = { host: TS, "tailscale-user-login": "captain@example.com" };
    expect(requestRefusal(req({ ...h, origin: `https://${TS}`, "sec-fetch-site": "same-origin" }, "POST"), 8787)).toBeNull();
    expect(requestRefusal(req({ ...h, origin: "https://evil.example" }, "POST"), 8787)).toBe("cross-origin request");
  });
  test("FLEET_TAILNET_USERS admits only the listed logins", () => {
    process.env.FLEET_TAILNET_USERS = "captain@example.com";
    expect(requestRefusal(req({ host: TS, "tailscale-user-login": "Captain@example.com" }), 8787)).toBeNull();
    expect(requestRefusal(req({ host: TS, "tailscale-user-login": "guest@example.com" }), 8787)).toContain("not allowed");
  });
});
