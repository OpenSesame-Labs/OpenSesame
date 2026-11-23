/**
 * Candidate coverage checks out the selected snapshot only in a read-only job.
 * That job has no token. CANDIDATE_REVISION is bound to
 * the admission job's output: a source already on main.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/ci-coverage.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("ci-coverage untrusted checkout", () => {
  it("checks out the selected snapshot only from the read-only coverage job", () => {
    const job = workflow.jobs.coverage;
    expect(job.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(JSON.stringify(job)).not.toContain("github.token");
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(JSON.stringify(job)).not.toContain("id-token");
    expect(JSON.stringify(job)).not.toContain("attestations");
    expect(job.env.CANDIDATE_REVISION).toBe(
      "${{ needs.admit.outputs.revision }}",
    );
    const refs = checkouts(job).map((step) => step.with.ref);
    expect(refs).toEqual([
      "${{ github.workflow_sha }}",
      "${{ env.CANDIDATE_REVISION }}",
    ]);
    const candidate = checkouts(job).find(
      (step) => step.with.ref === "${{ env.CANDIDATE_REVISION }}",
    );
    expect(candidate.with["persist-credentials"]).toBe(false);
    expect(candidate.with["fetch-depth"]).toBe(0);
    expect(candidate.with.filter).toBe("blob:none");
  });

  it("refuses an unsafe pull-request checkout on every actions/checkout step", () => {
    const blocks = yaml.split(/(?=^\s*-?\s*uses: actions\/checkout@)/m);
    const checkoutsText = blocks.filter((block) =>
      /uses:\s*actions\/checkout@/.test(block),
    );
    expect(checkoutsText.length).toBe(3);
    for (const block of checkoutsText) {
      expect(block).toContain("allow-unsafe-pr-checkout: false");
      expect(block).toContain("persist-credentials: false");
      // The admission step after the last checkout reads the raw input; no ref does.
      expect(block.match(/ref: .*/)?.[0] ?? "").not.toContain("inputs.");
    }
  });
});
