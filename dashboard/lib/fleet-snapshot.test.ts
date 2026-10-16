import { describe, expect, test } from "bun:test";
import {
  collectCaptainHolds,
  parseProjectsMarkdown,
  projectSlug,
  type FleetSnapshot,
} from "./fleet-snapshot.ts";

describe("projectSlug", () => {
  test("uses the last path segment", () => {
    expect(projectSlug("/Users/avega/Workspace/Kinwork")).toBe("kinwork");
    expect(projectSlug("kinwork")).toBe("kinwork");
    expect(projectSlug("")).toBe("");
  });
});

describe("parseProjectsMarkdown", () => {
  test("reads registered ships", () => {
    const rows = parseProjectsMarkdown(
      "- kinwork [no-mistakes-prod-only] - Django app github.com/ajaradv/Kinwork (added 2026-10-09)\n",
    );
    expect(rows).toEqual([
      {
        id: "kinwork",
        note: "[no-mistakes-prod-only] - Django app github.com/ajaradv/Kinwork (added 2026-10-09)",
      },
    ]);
  });
});

describe("collectCaptainHolds", () => {
  test("reads a live hold from the backlog", () => {
    const snap: FleetSnapshot = {
      ok: true,
      tasks: [],
      backlog: [
        {
          id: "kinwork-stack-plan",
          title: "Plan KinWork frontend stack migration",
          captain_actionable: true,
          hold_reason: "Need a theme choice",
        },
      ],
    };
    expect(collectCaptainHolds(snap)).toEqual([
      {
        id: "kinwork-stack-plan",
        title: "Plan KinWork frontend stack migration",
        holdReason: "Need a theme choice",
      },
    ]);
  });
});
