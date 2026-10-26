import { describe, expect, test } from "bun:test";
import { checkShell, triageFailure } from "./ship-checks.ts";

describe("failure triage", () => {
  const said = (choice: string, p: number) => (async () => ({ ok: true, answers: { cause: { type: "choice", choice, confidence: p, probabilities: { [choice]: p } } }, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 })) as never;
  test("a confident cause becomes one advisory line with a hint; unsure or other adds nothing", async () => {
    expect(await triageFailure("pytest", "just pytest", "docker: Cannot connect to the Docker daemon", said("environment", 0.92))).toBe(
      "Triage (Jev, advisory): most likely environment (92%); the tooling failed, not the code (Docker, a missing binary or dependency, network, permissions, disk, a port): fix or report the environment rather than editing code.",
    );
    expect(await triageFailure("pytest", "just pytest", "x", said("code_bug", 0.4))).toBeNull();
    expect(await triageFailure("pytest", "just pytest", "x", said("other", 0.9))).toBeNull();
    expect(await triageFailure("pytest", "just pytest", "x", (async () => ({ ok: false, error: "down" })) as never)).toBeNull();
  });
});

describe("the check shell", () => {
  test("zsh where it exists (macOS, the laptop); bash on a hub without it", () => {
    const local = { kind: "local" } as never;
    expect(checkShell(local, () => true)).toBe("/bin/zsh");
    expect(checkShell(local, () => false)).toBe("/bin/bash");
    expect(checkShell({ kind: "laptop" } as never, () => false)).toBe("/bin/zsh");
    expect(checkShell({ kind: "vm" } as never, () => true)).toBe("/bin/bash");
  });
});
