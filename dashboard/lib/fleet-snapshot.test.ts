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

describe("snapshot sharing", () => {
  test("callers at the same time share one run; views reuse a recent snapshot", async () => {
    const fs = await import("./fleet-snapshot.ts");
    fs._setFleetSnapshot(null);
    const a = fs.runFleetSnapshotJson();
    const b = fs.runFleetSnapshotJson();
    expect(a).toBe(b);
    await a;
    const cached = { ok: true, tasks: [], backlog: [] };
    fs._setFleetSnapshot(cached, 10_000);
    expect(await fs.recentFleetSnapshot()).toBe(cached);
    fs._setFleetSnapshot(cached, 60_000);
    expect(await fs.recentFleetSnapshot(120_000)).toBe(cached);
    fs._setFleetSnapshot(null);
  });
});
