/**
 * Reusable qualification workflows receive the candidate as `source_sha`.
 * None of them fetches that input directly: a token-holding admission job that
 * checks out only the workflow SHA admits a full commit already on the default
 * branch (scripts/release/admit-candidate-source.mjs), and every candidate
 * checkout or materialization reads that job's `revision` output, directly or
 * through a job-level CANDIDATE_REVISION bound to it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { isJsonObject } from "./json-boundary.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const root = repoRootFromHere();
// workflow -> [admission job id, candidate jobs]
const WORKFLOWS = {
  "autofill-browser.yml": ["admit", ["browser"]],
  "ci-coverage.yml": ["admit", ["coverage"]],
  "ci-dev-checks.yml": ["admit", ["agent37-iac", "artifact-smoke"]],
  "ci-prerelease-checks.yml": [
    "admit",
    [
      "changes",
      "behavior-verification",
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
    ],
  ],
  // ci-release-checks already has an `admit` job (candidate verification).
  "ci-release-checks.yml": ["admit-source", ["mutation", "security"]],
  "codeql.yml": ["admit", ["analyze", "analyze-native-go", "verify-sarif"]],
  "complete-verify.yml": ["admit", ["verify"]],
  "container-build-pr.yml": ["admit", ["build"]],
  "full-suite.yml": ["admit", ["typescript-full"]],
  "native-platform-validation.yml": ["admit", ["core", "cli", "release"]],
  "password-parity.yml": ["admit", ["parity"]],
  "pwa-native-wasm.yml": ["admit", ["native-wasm"]],
  "sync-target-security.yml": ["admit", ["authorization"]],
};
// Workflows a manual dispatch or schedule can also run on their own SHA.
const OPTIONAL = new Set([
  "autofill-browser.yml",
  "codeql.yml",
  "sync-target-security.yml",
]);

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
  for (const [name, [admitId, jobs]] of Object.entries(WORKFLOWS)) {
    const output = `needs.${admitId}.outputs.revision`;

    it(`${name} admits the candidate in a workflow-SHA-only job`, () => {
      const { doc } = load(name);
      const admit = doc.jobs[admitId];
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
      if (OPTIONAL.has(name)) expect(admit.if).toBe("${{ inputs.source_sha }}");
      else expect(admit.if).toBeUndefined();
    });

    it(`${name} fetches only the admitted revision`, () => {
      const { doc } = load(name);
      for (const id of jobs) {
        const job = doc.jobs[id];
        expect(needs(job), id).toContain(admitId);
        expect(JSON.stringify(job), id).toContain(output);
        for (const checkout of checkouts(job))
          expect(checkout.with.ref ?? "", id).not.toContain("inputs.");
        if (job.env?.CANDIDATE_REVISION !== undefined)
          expect(job.env.CANDIDATE_REVISION, id).toBe(`\${{ ${output} }}`);
      }
      for (const [id, job] of Object.entries(doc.jobs)) {
        for (const step of job.steps ?? [])
          expect(step.env?.TARGET_SHA ?? "", id).not.toContain("inputs.");
        expect(job.env?.CANDIDATE_REVISION ?? "", id).not.toContain("inputs.");
      }
    });
  }

  it("no reusable workflow checks out a caller-supplied revision", () => {
    const dir = join(root, ".github/workflows");
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const { doc } = load(file);
      const on = doc.on ?? doc.true;
      if (!isJsonObject(on) || !("workflow_call" in on)) continue;
      for (const [id, job] of Object.entries(doc.jobs ?? {}))
        for (const checkout of checkouts(job))
          expect(checkout.with?.ref ?? "", `${file} ${id}`).not.toContain(
            "inputs.",
          );
    }
  });

  it("a run without a candidate skips admission; a candidate run requires it", () => {
    for (const [name, jobs] of [
      ["codeql.yml", ["analyze", "analyze-native-go"]],
      ["autofill-browser.yml", ["browser"]],
      ["sync-target-security.yml", ["authorization"]],
    ]) {
      const { doc } = load(name);
      for (const id of jobs)
        expect(doc.jobs[id].if, `${name} ${id}`).toBe(
          "${{ !cancelled() && (needs.admit.result == 'success' || (needs.admit.result == 'skipped' && !inputs.source_sha)) }}",
        );
    }
    const gate = load("codeql.yml").doc.jobs["verify-sarif"].steps[0];
    expect(gate.run).toContain('test "$ADMIT_RESULT" = success');
  });
});
