/**
 * Prerelease checks check out the selected snapshot only in read-only jobs.
 * Those jobs have no token. A checkout ref field whose name contains "sha" is an
 * untrusted pull-request head, so the snapshot is bound to CANDIDATE_REVISION.
 * A job that carries github.token checks out the workflow SHA, never that tree.
 * The privileged materialize job uploads verified archives. Smoke downloads them.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const WORKFLOW = ".github/workflows/ci-prerelease-checks.yml";
const root = repoRootFromHere();
const yaml = readFileSync(join(root, WORKFLOW), "utf8");
const workflow = parse(yaml);

const UNTRUSTED = [
  "changes",
  "typescript-tests",
  "bundle",
  "ai-connections-e2e",
  "tailnet-browser-node-e2e",
  "device-inbox",
  "push-e2e",
  "device-identity-e2e",
  "tutorials-e2e",
  "live-join-e2e",
  "rust",
  "android-native",
  "apple-native",
  "mtls",
  "artifact-smoke",
];

function checkouts(job) {
  return (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
}

describe("ci-prerelease-checks untrusted checkout", () => {
  it("checks out the selected snapshot only from read-only jobs", () => {
    expect(
      Object.entries(workflow.jobs)
        .filter(([, job]) =>
          checkouts(job).some(
            (step) => step.with.ref === "${{ env.CANDIDATE_REVISION }}",
          ),
        )
        .map(([name]) => name)
        .sort(),
    ).toEqual([...UNTRUSTED].sort());
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
      const candidate = checkouts(job).find(
        (step) => step.with.ref === "${{ env.CANDIDATE_REVISION }}",
      );
      expect(candidate.with["persist-credentials"], name).toBe(false);
      expect(candidate.with["allow-unsafe-pr-checkout"], name).toBe(false);
    }
  });

  it("keeps token-bearing jobs on the workflow SHA and published archives", () => {
    const tokenJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      JSON.stringify(job).includes("github.token"),
    );
    expect(tokenJobs.map(([name]) => name).sort()).toEqual([
      "admission",
      "artifact-materialize",
      "receipt",
    ]);
    for (const [name, job] of tokenJobs) {
      const refs = checkouts(job).map((step) => step.with.ref);
      expect(refs, name).toEqual(["${{ github.workflow_sha }}"]);
      expect(JSON.stringify(job), name).not.toContain("CANDIDATE_REVISION");
    }
    const materialize = workflow.jobs["artifact-materialize"];
    expect(JSON.stringify(materialize)).toContain("actions/upload-artifact@");
    expect(materialize.outputs.pages_archive).toBe(
      "${{ steps.layout.outputs.pages_archive }}",
    );
    const smoke = workflow.jobs["artifact-smoke"];
    expect(smoke.needs).toEqual(["admission", "artifact-materialize"]);
    expect(JSON.stringify(smoke)).toContain("actions/download-artifact@");
    expect(JSON.stringify(smoke)).toContain(
      "needs.artifact-materialize.outputs.pages_archive",
    );
    expect(JSON.stringify(smoke)).not.toContain("steps.candidate.outputs");
  });

  it("refuses an unsafe pull-request checkout on every actions/checkout step", () => {
    const blocks = yaml.split(/(?=^\s*-?\s*uses: actions\/checkout@)/m);
    const checkoutsText = blocks.filter((block) =>
      /uses:\s*actions\/checkout@/.test(block),
    );
    expect(checkoutsText.length).toBe(34);
    for (const block of checkoutsText) {
      const step = block.split(/\n\s*- /)[0];
      expect(step).toContain("allow-unsafe-pr-checkout: false");
      expect(step).toContain("persist-credentials: false");
      expect(step).not.toContain("inputs.source_sha");
    }
  });
});
