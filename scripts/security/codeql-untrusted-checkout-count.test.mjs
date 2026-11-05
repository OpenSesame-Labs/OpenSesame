import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseUntrustedCheckoutArgs,
  summarizeUntrustedCheckoutSarif,
} from "./codeql-untrusted-checkout-count.mjs";

test("summarizeUntrustedCheckoutSarif counts only untrusted-checkout rules", () => {
  const summary = summarizeUntrustedCheckoutSarif({
    runs: [
      {
        results: [
          {
            ruleId: "actions/untrusted-checkout/medium",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: ".github/workflows/candidate-build.yml",
                  },
                },
              },
            ],
          },
          {
            ruleId: "actions/untrusted-checkout/critical",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: ".github/workflows/candidate-build.yml",
                  },
                },
              },
            ],
          },
          {
            ruleId: "actions/untrusted-checkout-toctou/high",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: ".github/workflows/candidate-build.yml",
                  },
                },
              },
            ],
          },
          {
            ruleId: "actions/cache-poisoning/poisonable-step",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: ".github/workflows/ci.yml" },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.byFile, { "candidate-build.yml": 2 });
  assert.deepEqual(summary.byRule, {
    "actions/untrusted-checkout/critical": 1,
    "actions/untrusted-checkout/medium": 1,
  });
});

test("parseUntrustedCheckoutArgs accepts one workflow basename", () => {
  assert.deepEqual(
    parseUntrustedCheckoutArgs(["--workflow", "candidate-build.yml"]),
    { workflow: "candidate-build.yml" },
  );
  assert.throws(
    () => parseUntrustedCheckoutArgs(["--workflow", "../candidate-build.yml"]),
    /workflow basename/u,
  );
  assert.throws(
    () => parseUntrustedCheckoutArgs(["--profile", "codeql"]),
    /unknown argument/u,
  );
});
