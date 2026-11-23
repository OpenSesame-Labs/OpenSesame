import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/ci-dev-checks.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("ci-dev-checks artifact-smoke untrusted checkout", () => {
  it("materializes source_sha instead of actions/checkout", () => {
    const job = workflow.jobs["artifact-smoke"];
    const refs = checkouts(job).map((step) => step.with.ref);
    expect(refs).toEqual(["${{ github.workflow_sha }}"]);
    const materialize = job.steps.find((step) =>
      step.name?.includes("Materialize the admitted candidate source"),
    );
    expect(materialize?.env?.TARGET_SHA).toBe(
      "${{ needs.admit.outputs.revision }}",
    );
    expect(materialize?.run).toContain("materialize-git-sha.sh");
    expect(checkouts(job)[0].with.path).toBe(".ci-control");
    const park = job.steps.find((step) =>
      step.name?.includes(
        "Park trusted helpers outside the candidate checkout",
      ),
    );
    expect(park?.run).toContain('mv .ci-control "$RUNNER_TEMP/ci-control"');
  });

  it("refuses an unsafe pull-request checkout on artifact-smoke checkouts", () => {
    for (const step of checkouts(workflow.jobs["artifact-smoke"])) {
      expect(step.with["persist-credentials"]).toBe(false);
      expect(step.with["allow-unsafe-pr-checkout"]).toBe(false);
    }
  });
});
