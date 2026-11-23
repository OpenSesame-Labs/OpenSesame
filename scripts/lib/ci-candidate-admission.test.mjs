/**
 * Reusable qualification workflows receive the candidate as `source_sha`.
 * None of them fetches that input directly: a token-holding `admit` job that
 * checks out only the workflow SHA admits a full commit already on the default
 * branch (scripts/release/admit-candidate-source.mjs), and every candidate
 * checkout or materialization reads that job's `revision` output.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const root = repoRootFromHere();
const ADMITTED = "${{ needs.admit.outputs.revision }}";
const WORKFLOWS = {
  "ci-dev-checks.yml": ["agent37-iac", "artifact-smoke"],
  "codeql.yml": ["analyze", "analyze-native-go", "verify-sarif"],
  "complete-verify.yml": ["verify"],
  "container-build-pr.yml": ["build"],
  "full-suite.yml": ["typescript-full"],
  "password-parity.yml": ["parity"],
  "pwa-native-wasm.yml": ["native-wasm"],
};

function load(name) {
  const text = readFileSync(join(root, ".github/workflows", name), "utf8");
  return { text, doc: parse(text) };
}
const checkouts = (job) =>
  (job.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
const needs = (job) => [job.needs ?? []].flat();

describe("candidate admission before checkout", () => {
  for (const [name, jobs] of Object.entries(WORKFLOWS)) {
    it(`${name} admits the candidate in a workflow-SHA-only job`, () => {
      const { doc } = load(name);
      const admit = doc.jobs.admit;
      expect(admit.permissions).toEqual({ contents: "read" });
      expect(admit.outputs.revision).toBe(
        "${{ steps.admitted.outputs.revision }}",
      );
      expect(checkouts(admit).map((step) => step.with.ref)).toEqual([
        "${{ github.workflow_sha }}",
      ]);
      expect(checkouts(admit)[0].with["persist-credentials"]).toBe(false);
      const step = admit.steps.find((entry) => entry.id === "admitted");
      expect(step.run).toBe("node scripts/release/admit-candidate-source.mjs");
      expect(step.env.REQUESTED_SOURCE).toBe("${{ inputs.source_sha }}");
    });

    it(`${name} fetches only the admitted revision`, () => {
      const { doc } = load(name);
      for (const id of jobs) {
        const job = doc.jobs[id];
        expect(needs(job), id).toContain("admit");
        const candidate = JSON.stringify(job);
        expect(candidate, id).toContain("needs.admit.outputs.revision");
        for (const checkout of checkouts(job))
          expect(checkout.with.ref ?? "", id).not.toContain("inputs.");
      }
      // No step anywhere checks out or materializes the raw input.
      for (const [id, job] of Object.entries(doc.jobs)) {
        for (const checkout of checkouts(job))
          expect(checkout.with?.ref ?? "", id).not.toContain("source_sha");
        for (const step of job.steps ?? [])
          expect(step.env?.TARGET_SHA ?? "", id).not.toContain("inputs.");
      }
    });
  }

  it("candidate checkouts read the admitted revision exactly", () => {
    const refs = Object.entries(WORKFLOWS).flatMap(([name, jobs]) =>
      jobs.flatMap((id) =>
        checkouts(load(name).doc.jobs[id])
          .map((step) => step.with.ref)
          .filter((ref) => ref !== "${{ github.workflow_sha }}"),
      ),
    );
    for (const ref of refs)
      expect([
        ADMITTED,
        "${{ needs.admit.outputs.revision || github.sha }}",
      ]).toContain(ref);
  });

  it("a monitoring CodeQL run skips admission; a candidate run requires it", () => {
    const { doc } = load("codeql.yml");
    expect(doc.jobs.admit.if).toBe("${{ inputs.source_sha }}");
    for (const id of ["analyze", "analyze-native-go"])
      expect(doc.jobs[id].if).toBe(
        "${{ !cancelled() && (needs.admit.result == 'success' || (needs.admit.result == 'skipped' && !inputs.source_sha)) }}",
      );
    const gate = doc.jobs["verify-sarif"].steps[0];
    expect(gate.run).toContain('test "$ADMIT_RESULT" = success');
  });
});
