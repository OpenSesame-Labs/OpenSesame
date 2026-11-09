import { describe, expect, it } from "vitest";
import {
  assertCompleteResults,
  assertSelectedResult,
} from "./ci-required-result.mjs";

function withRunAttempt(attempt, run) {
  const previous = process.env.GITHUB_RUN_ATTEMPT;
  if (attempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
  else process.env.GITHUB_RUN_ATTEMPT = attempt;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previous;
  }
}

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
  it.each([undefined, "1"])(
    "rejects an abandoned selected suite on attempt %s",
    (attempt) => {
      withRunAttempt(attempt, () => {
        expect(() =>
          assertSelectedResult({ ...admitted, result: "abandoned" }),
        ).toThrow(/selected suite: abandoned/u);
      });
    },
  );
  it.each(["2", "3"])(
    "accepts an abandoned selected suite on attempt %s after a successful preflight",
    (attempt) => {
      withRunAttempt(attempt, () => {
        expect(() =>
          assertSelectedResult({ ...admitted, result: "abandoned" }),
        ).not.toThrow();
      });
    },
  );
  it("rejects an abandoned selected suite on a later attempt when preflight did not succeed", () => {
    withRunAttempt("2", () => {
      expect(() =>
        assertSelectedResult({
          ...admitted,
          preflight: "failure",
          result: "abandoned",
        }),
      ).toThrow(/preflight: failure/u);
    });
  });
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
  it("accepts a superseded run when preflight was cancelled", () => {
    expect(() =>
      assertSelectedResult({
        draft: "",
        preflight: "cancelled",
        selected: "",
        result: "cancelled",
      }),
    ).not.toThrow();
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
