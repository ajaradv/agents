import { describe, expect, test } from "bun:test";
import { reviewLevel } from "./dock-review.ts";

const sc = (score: number) => ({ type: "score" as const, score, probabilities: {}, confidence: 0.9 });
const n = (noul: number) => ({ type: "noul" as const, noul });

describe("dock review", () => {
  test("weights in code: security dominates, clear commits lower the risk", () => {
    expect(reviewLevel({ security: sc(0), complexity: sc(0.5), commit_quality: sc(3), needs_review: n(0.1) }).level).toBe("light");
    expect(reviewLevel({ security: sc(1), complexity: sc(2), commit_quality: sc(2), needs_review: n(0.3) }).level).toBe("normal");
    expect(reviewLevel({ security: sc(2.5), complexity: sc(1), commit_quality: sc(3), needs_review: n(0.2) }).level).toBe("careful");
    expect(reviewLevel({ security: sc(0), complexity: sc(1), commit_quality: sc(3), needs_review: n(0.9) }).level).toBe("careful");
  });
});
