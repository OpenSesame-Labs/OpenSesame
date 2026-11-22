import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/pr-visual-evidence.yml";
const root = repoRootFromHere();
const workflow = parse(readFileSync(join(root, WORKFLOW), "utf8"));

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("pr-visual-evidence untrusted checkout", () => {
  it("does not actions/checkout the pull-request head", () => {
    const job = workflow.jobs.evidence;
    expect(checkouts(job)).toHaveLength(1);
    expect(checkouts(job)[0].with.path).toBe("base");
    expect(
      job.steps.some((step) =>
        step.run?.includes("pr-visual-materialize-head.sh"),
      ),
    ).toBe(true);
  });

  it("refuses an unsafe pull-request checkout on actions/checkout", () => {
    for (const step of checkouts(workflow.jobs.evidence)) {
      expect(step.with["persist-credentials"]).toBe(false);
      expect(step.with["allow-unsafe-pr-checkout"]).toBe(false);
    }
  });
});
