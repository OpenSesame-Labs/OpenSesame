import { describe, expect, it } from "vitest";
import {
  assertCompleteResults,
  assertSelectedResult,
  superseded,
} from "./ci-required-result.mjs";

const admitted = {
  draft: "false",
  preflight: "success",
  selected: "true",
  result: "success",
};

describe("required integration results", () => {
  it("accepts an executed selected suite and an explicitly unselected suite", () => {
    expect(() => assertSelectedResult(admitted)).not.toThrow();
    expect(() =>
      assertSelectedResult({
        ...admitted,
        selected: "false",
        result: "skipped",
      }),
    ).not.toThrow();
  });
  it.each(["failure", "cancelled", "skipped", "", undefined])(
    "rejects selected result %s",
    (result) => {
      expect(() => assertSelectedResult({ ...admitted, result })).toThrow();
    },
  );
  it.each(["failure", "skipped", "", undefined])(
    "never turns failed classification %s into a skip success",
    (preflight) => {
      expect(() =>
        assertSelectedResult({
          ...admitted,
          preflight,
          selected: "false",
          result: "skipped",
        }),
      ).toThrow();
    },
  );
  it("accepts a cancelled preflight only when a newer push replaced the run", () => {
    const cancelled = {
      draft: "",
      preflight: "cancelled",
      selected: "",
      result: "cancelled",
    };
    expect(() =>
      assertSelectedResult({ ...cancelled, replaced: true }),
    ).not.toThrow();
    // Cancelled by hand, or on main or in the merge queue: nothing was
    // classified or built, so it must not read as a passing check.
    expect(() => assertSelectedResult(cancelled)).toThrow(/no newer push/);
    expect(() =>
      assertSelectedResult({ ...cancelled, replaced: false }),
    ).toThrow(/no newer push/);
  });
  it("calls a run superseded only for a pull request whose head moved", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const run = { event: "pull_request", runHead: a, pull: "7" };
    expect(superseded(run, () => b)).toBe(true);
    expect(superseded(run, () => a)).toBe(false);
    for (const event of ["push", "merge_group", "workflow_dispatch", undefined])
      expect(superseded({ ...run, event }, () => b)).toBe(false);
    expect(superseded({ ...run, runHead: "" }, () => b)).toBe(false);
    expect(superseded({ ...run, pull: "7; rm" }, () => b)).toBe(false);
    expect(superseded({ ...run, pull: undefined }, () => b)).toBe(false);
    expect(superseded(run, () => "")).toBe(false);
    expect(superseded(run, () => "not-a-sha")).toBe(false);
    expect(
      superseded(run, () => {
        throw new Error("offline");
      }),
    ).toBe(false);
  });
  it.each(["true", "", undefined])(
    "rejects draft or absent admission %s even with green suites",
    (draft) => {
      expect(() => assertSelectedResult({ ...admitted, draft })).toThrow();
    },
  );
  it.each(["", "yes", undefined])(
    "rejects missing or malformed area selection %s",
    (selected) => {
      expect(() =>
        assertSelectedResult({ ...admitted, selected, result: "skipped" }),
      ).toThrow();
    },
  );
});

describe("complete qualification", () => {
  it("requires all matrices, auxiliary checks and admission to succeed", () => {
    const needs = {
      admission: { result: "success" },
      browser: { result: "success" },
      native: { result: "success" },
    };
    expect(() => assertCompleteResults(needs)).not.toThrow();
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      expect(() =>
        assertCompleteResults({ ...needs, native: { result } }),
      ).toThrow();
    }
  });
  it.each([null, [], {}, { native: {} }])(
    "cannot produce green qualification with absent work",
    (needs) => {
      expect(() => assertCompleteResults(needs)).toThrow();
    },
  );
});
