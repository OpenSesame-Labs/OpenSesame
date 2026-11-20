import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { describe, expect, it } from "vitest";
import { guideSnapshotActive } from "./guide-snapshot-active.js";

const done: GuideRuntimeSnapshot = {
  status: "done",
  goal: "vault.lock",
  index: 1,
  total: 1,
  runId: 1,
  message: "Done.",
  error: null,
  tour: null,
};

describe("guideSnapshotActive", () => {
  it("treats terminal snapshots as idle", () => {
    expect(guideSnapshotActive(null)).toBe(false);
    expect(guideSnapshotActive(done)).toBe(false);
    expect(
      guideSnapshotActive({ ...done, status: "failed", error: { code: "x" } }),
    ).toBe(false);
  });

  it("treats in-flight statuses as active", () => {
    for (const status of ["running", "waiting", "paused"] as const) {
      expect(guideSnapshotActive({ ...done, status, tour: done.tour })).toBe(
        true,
      );
    }
  });
});
