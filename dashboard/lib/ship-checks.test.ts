import { describe, expect, test } from "bun:test";
import { triageFailure } from "./ship-checks.ts";

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
