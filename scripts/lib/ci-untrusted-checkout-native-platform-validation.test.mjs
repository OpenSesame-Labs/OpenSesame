/**
 * Native platform validation checks out the selected snapshot only in read-only
 * jobs. Those jobs have no token. A checkout ref field whose name contains
 * "sha" is an untrusted pull-request head, so the snapshot is bound to
 * CANDIDATE_REVISION. A job that carries github.token checks out the workflow
 * SHA, never that tree.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/native-platform-validation.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

const UNTRUSTED = ["core", "cli", "release"];

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("native-platform-validation untrusted checkout", () => {
  it("checks out the selected snapshot only from read-only jobs", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([...UNTRUSTED].sort());
    for (const name of UNTRUSTED) {
      const job = workflow.jobs[name];
      expect(job.permissions, name).toEqual({
        contents: "read",
        actions: "read",
      });
      expect(JSON.stringify(job), name).not.toContain("github.token");
      expect(JSON.stringify(job), name).not.toContain("secrets.");
      expect(JSON.stringify(job), name).not.toContain("id-token");
      expect(JSON.stringify(job), name).not.toContain("attestations");
      expect(job.env.CANDIDATE_REVISION, name).toBe("${{ inputs.source_sha }}");
      expect(job.env.EXPECTED_HEAD, name).toBe("${{ inputs.source_sha }}");
      const refs = checkouts(job).map((step) => step.with.ref);
      expect(refs, name).toEqual([
        "${{ github.workflow_sha }}",
        "${{ env.CANDIDATE_REVISION }}",
      ]);
      const candidate = checkouts(job).find(
        (step) => step.with.ref === "${{ env.CANDIDATE_REVISION }}",
      );
      expect(candidate.with["persist-credentials"], name).toBe(false);
      expect(candidate.with["allow-unsafe-pr-checkout"], name).toBe(false);
    }
  });

  it("keeps token-bearing jobs off the selected snapshot", () => {
    const tokenJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      JSON.stringify(job).includes("github.token"),
    );
    expect(tokenJobs).toEqual([]);
  });

  it("refuses an unsafe pull-request checkout on every actions/checkout step", () => {
    const blocks = yaml.split(/(?=^\s*-?\s*uses: actions\/checkout@)/m);
    const checkoutsText = blocks.filter((block) =>
      /uses:\s*actions\/checkout@/.test(block),
    );
    expect(checkoutsText.length).toBe(6);
    for (const block of checkoutsText) {
      const step = block.split(/\n\s*- /)[0];
      expect(step).toContain("allow-unsafe-pr-checkout: false");
      expect(step).toContain("persist-credentials: false");
      expect(step).not.toContain("inputs.source_sha");
    }
  });
});
