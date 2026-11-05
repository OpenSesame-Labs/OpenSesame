/**
 * Candidate build checks out the selected snapshot only in read-only jobs.
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

const WORKFLOW = ".github/workflows/candidate-build.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

const UNTRUSTED = ["bridge-untrusted", "pages-untrusted", "native-untrusted"];

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("candidate-build untrusted checkout", () => {
  it("checks out the selected snapshot only from read-only jobs", () => {
    for (const name of UNTRUSTED) {
      const job = workflow.jobs[name];
      expect(job.permissions, name).toEqual({
        contents: "read",
        actions: "read",
      });
      expect(JSON.stringify(job), name).not.toContain("github.token");
      expect(JSON.stringify(job), name).not.toContain("secrets.");
      expect(job.env.CANDIDATE_REVISION, name).toBe(
        "${{ needs.resolve.outputs.source_sha }}",
      );
      const candidate = checkouts(job).find((step) => step.with.path === "src");
      expect(candidate.with.ref, name).toBe("${{ env.CANDIDATE_REVISION }}");
      expect(candidate.with["persist-credentials"], name).toBe(false);
    }
  });

  it("keeps token-bearing jobs on the workflow SHA", () => {
    const tokenJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      JSON.stringify(job).includes("github.token"),
    );
    expect(tokenJobs.map(([name]) => name).sort()).toEqual([
      "accept-bridge",
      "manifest",
      "resolve",
    ]);
    for (const [name, job] of tokenJobs) {
      const refs = checkouts(job).map((step) => step.with.ref);
      expect(refs, name).toEqual(["${{ github.workflow_sha }}"]);
      expect(JSON.stringify(job), name).not.toContain("CANDIDATE_REVISION");
    }
  });

  it("refuses an unsafe pull-request checkout on every actions/checkout step", () => {
    const blocks = yaml.split(/(?=^\s*-?\s*uses: actions\/checkout@)/m);
    const checkoutsText = blocks.filter((block) =>
      /uses:\s*actions\/checkout@/.test(block),
    );
    expect(checkoutsText.length).toBeGreaterThan(0);
    for (const block of checkoutsText) {
      expect(block).toContain("allow-unsafe-pr-checkout: false");
      expect(block).toContain("persist-credentials: false");
    }
  });
});
