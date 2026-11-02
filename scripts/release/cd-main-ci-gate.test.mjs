import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requiredMainCiJobsSucceeded,
  verifyMainCiGate,
} from "./cd-main-ci-gate.mjs";

test("required main CI reporters must all succeed", () => {
  assert.doesNotThrow(() =>
    requiredMainCiJobsSucceeded([
      { name: "TypeScript", conclusion: "success" },
      { name: "Rust", conclusion: "success" },
      { name: "Bundle budgets", conclusion: "success" },
    ]),
  );
  assert.throws(
    () =>
      requiredMainCiJobsSucceeded([
        { name: "TypeScript", conclusion: "success" },
        { name: "Rust", conclusion: "failure" },
        { name: "Bundle budgets", conclusion: "success" },
      ]),
    /Rust/,
  );
});

test("verifyMainCiGate accepts a successful push run for the commit", async () => {
  const sha = "a".repeat(40);
  const fetchImpl = async (url) => {
    if (url.includes("/workflows/ci.yml/runs")) {
      return {
        ok: true,
        json: async () => ({
          workflow_runs: [
            {
              id: 99,
              conclusion: "success",
              head_branch: "main",
              head_sha: sha,
            },
          ],
        }),
      };
    }
    if (url.includes("/runs/99/jobs")) {
      return {
        ok: true,
        json: async () => ({
          jobs: [
            { name: "TypeScript", conclusion: "success" },
            { name: "Rust", conclusion: "success" },
            { name: "Bundle budgets", conclusion: "success" },
          ],
        }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await verifyMainCiGate(
    {
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: "OpenSesame-Labs/OpenSesame",
      GITHUB_TOKEN: "test-token",
    },
    { fetch: fetchImpl },
  );
});
