/**
 * Candidate release checks check out the selected snapshot only in read-only jobs.
 * Those jobs have no token. A checkout ref field whose name contains "sha" is an
 * untrusted pull-request head, so the snapshot is bound to CANDIDATE_REVISION.
 * A job that carries github.token checks out the workflow SHA, never that tree.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/ci-release-checks.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

const UNTRUSTED = ["mutation", "security"];

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("ci-release-checks untrusted checkout", () => {
  it("checks out the selected snapshot only from read-only jobs", () => {
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
      const refs = checkouts(job).map((step) => step.with.ref);
      expect(refs, name).toEqual([
        "${{ github.workflow_sha }}",
        "${{ env.CANDIDATE_REVISION }}",
      ]);
      const trusted = checkouts(job).find(
        (step) => step.with.ref === "${{ github.workflow_sha }}",
      );
      expect(trusted.with["sparse-checkout"], name).toContain(
        "scripts/release",
      );
      const candidate = checkouts(job).find(
        (step) => step.with.ref === "${{ env.CANDIDATE_REVISION }}",
      );
      expect(candidate.with["persist-credentials"], name).toBe(false);
      expect(candidate.with["fetch-depth"], name).toBe(0);
      expect(candidate.with.filter, name).toBe("blob:none");
    }
  });

  it("keeps token-bearing jobs on the workflow SHA", () => {
    const tokenJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      JSON.stringify(job).includes("github.token"),
    );
    expect(tokenJobs.map(([name]) => name).sort()).toEqual(["admit", "record"]);
    for (const [name, job] of tokenJobs) {
      const refs = checkouts(job).map((step) => step.with.ref);
      expect(refs, name).toEqual(["${{ github.workflow_sha }}"]);
      expect(JSON.stringify(job), name).not.toContain("CANDIDATE_REVISION");
    }
    expect(workflow.jobs.codeql.steps).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.codeql)).not.toContain(
      "actions/checkout",
    );
    expect(JSON.stringify(workflow.jobs.codeql)).not.toContain(
      "CANDIDATE_REVISION",
    );
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
