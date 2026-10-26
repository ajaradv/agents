import { describe, expect, test } from "bun:test";
import { isTailscaleAddress, validWorkerToken } from "../worker.ts";

describe("isTailscaleAddress", () => {
  test("the tailnet's IPv4 range, plain and IPv4-mapped", () => {
    for (const a of ["100.64.0.1", "100.101.2.3", "100.127.255.254", "::ffff:100.101.2.3"]) expect(isTailscaleAddress(a)).toBe(true);
  });
  test("the tailnet's IPv6 range", () => {
    for (const a of ["fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6265:1234", "FD7A:115C:A1E0::5"]) expect(isTailscaleAddress(a)).toBe(true);
  });
  test("everything else, including the edges of the range", () => {
    for (const a of ["100.63.255.255", "100.128.0.0", "10.0.0.1", "127.0.0.1", "::1", "::ffff:10.1.2.3", "fd7a:115c:a1e1::1", "fe80::1", "", undefined, null]) expect(isTailscaleAddress(a)).toBe(false);
  });
});

describe("validWorkerToken", () => {
  test("URL-safe, 32 to 256 characters", () => {
    expect(validWorkerToken("a".repeat(64))).toBe(true);
    expect(validWorkerToken("Ab_-".repeat(8))).toBe(true);
    expect(validWorkerToken("a".repeat(31))).toBe(false);
    expect(validWorkerToken("a".repeat(257))).toBe(false);
    expect(validWorkerToken(`${"a".repeat(40)}\n`)).toBe(false);
    expect(validWorkerToken(`${"a".repeat(40)} x`)).toBe(false);
    expect(validWorkerToken(123)).toBe(false);
  });
});
