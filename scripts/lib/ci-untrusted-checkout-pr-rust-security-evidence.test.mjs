import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/pr-rust-security-evidence.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("pr-rust-security-evidence untrusted checkout", () => {
  it("installs Rust before materializing the pull-request head", () => {
    const evidence = workflow.jobs.evidence;
    const names = evidence.steps.map((step) => step.name ?? step.uses);
    expect(names.slice(0, 5)).toEqual([
      "Check out trusted materialization helpers",
      "Park trusted helpers outside the workspace root",
      "Install the explicit pinned Rust toolchain",
      "Materialize the exact PR head without actions/checkout",
      "Run the hardcoded exact-head security matrix",
    ]);
    expect(checkouts(evidence)[0].with.path).toBe(".ci-tools");
    expect(checkouts(evidence).every((step) => step.with.path !== "head")).toBe(
      true,
    );
  });

  it("never actions/checkouts the pull-request head", () => {
    const evidence = workflow.jobs.evidence;
    const refs = checkouts(evidence).map((step) => step.with.ref);
    expect(refs).toEqual(["${{ github.workflow_sha }}"]);
    expect(
      evidence.steps.some((step) =>
        step.run?.includes("materialize-git-sha.sh"),
      ),
    ).toBe(true);
  });
});
