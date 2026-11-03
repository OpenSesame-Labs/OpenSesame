/**
 * Workflow inventory for container and CD triggers.
 *
 * The gate moved off `typescript-build` because that job is optional: it
 * runs only when the affected graph selects TypeScript. PR #2440 and #2441
 * never executed this file. `workflow-inventory-gate` has no draft or
 * TypeScript `if:`, starts with `needs: []` beside `changes`, and runs this
 * file after `npm ci` on every CI `pull_request` and `merge_group`.
 *
 * The headless browser benchmark on main is `workflow_dispatch` only, so the
 * automatic pull_request/push/merge_group inventory omits
 * `cd-headless-browser-benchmark.yml`. This slice does not yet contain
 * `cd-ghcr-publish.yml`; the later slice adds that name when the workflow
 * file lands.
 *
 * Trunk still does not run `npm run quality:test`. Pre-push fast mode
 * (`.githooks/pre-push`) skips that aggregate suite too.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectedInspect } from "../ci/oci-image-config.mjs";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";

const trunkInventoryCommand =
  "npx vitest run scripts/lib/ci-container-build-pr.test.mjs";

const root = repoRootFromHere();
const file = join(root, ".github/workflows/container-build-pr.yml");
const yaml = readFileSync(file, "utf8");

describe("candidate-bound container validation", () => {
  it("builds the compose image and does not push", () => {
    expect(yaml).toContain("  workflow_call:");
    expect(yaml).not.toMatch(/^ {2}(?:pull_request|push|schedule):/m);
    expect(yaml).toContain("ref: ${{ inputs.source_sha }}");
    expect(yaml).toContain("contents: read");
    expect(yaml).not.toMatch(/packages:\s*write/);
    expect(yaml).not.toContain("push: true");
    expect(yaml).toContain("push: false");
    expect(yaml).toContain("timeout-minutes: 45");
    expect(yaml).toContain("file: ops/compose/Dockerfile");
    expect(yaml).toContain("context: .");
    expect(yaml).toContain("opensesame:candidate-${{ inputs.source_sha }}");
    expect(yaml).toContain("persist-credentials: false");
    expect(yaml).toContain(
      "uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0",
    );
  });

  it("is a TypeScript-area workflow, not a browser or Rust gate", () => {
    expect(areasForPaths([".github/workflows/container-build-pr.yml"])).toEqual(
      {
        typescript: true,
        bundle: false,
        rust: false,
        mtls: false,
        push: false,
      },
    );
  });
});

describe("opensesame image metadata", () => {
  it("prints the inspect contract and the Dockerfile matches it", () => {
    const ran = spawnSync(
      process.execPath,
      [join(root, "scripts/ci/oci-image-config.mjs")],
      { encoding: "utf8" },
    );
    expect(ran.status).toBe(0);
    const printed = JSON.parse(ran.stdout);
    const spec = expectedInspect().opensesame;
    expect(printed.opensesame.dockerInspect).toEqual(spec.dockerInspect);
    expect(printed.opensesame.repository).toBe(
      "ghcr.io/opensesame-labs/opensesame",
    );
    const docker = readFileSync(join(root, "ops/compose/Dockerfile"), "utf8");
    expect(docker).toMatch(new RegExp(`^USER ${spec.user}$`, "m"));
    expect(docker).toMatch(/^EXPOSE 8787$/m);
    expect(docker).toMatch(/^ENTRYPOINT \["opensesame"\]$/m);
    expect(docker).toMatch(/VOLUME \["\/var\/lib\/opensesame"\]/);
    expect(docker).toMatch(/ARG VERSION=0\.0\.0-local/);
    expect(docker).toMatch(/org\.opencontainers\.image\.source=/);
    expect(docker).toMatch(
      /org\.opencontainers\.image\.version="\$\{VERSION\}"/,
    );
    expect(docker).toMatch(/org\.opencontainers\.image\.licenses="MIT"/);
    expect(docker).toMatch(/org\.opencontainers\.image\.title="opensesame"/);
    expect(docker).toMatch(/dev\.opensesame\.env\.documentation=/);
    expect(docker).toMatch(/OPENSESAME_STATE_DIR=\/var\/lib\/opensesame/);
    expect(docker).toMatch(
      /CMD \["curl", "-fsS", "http:\/\/127\.0\.0\.1:8787\/health\/live"\]/,
    );
    expect(spec.dockerInspect.Entrypoint).toEqual(["opensesame"]);
    expect(spec.dockerInspect.ExposedPorts).toEqual({ "8787/tcp": {} });
    expect(spec.labels["org.opencontainers.image.version"]).toBe("0.0.0-local");
  });
});

/** CD workflows that push to main and do not run on pull_request. */
const cdPushMainOnly = ["cd-npm-cli.yml", "cd-pwa.yml"];

const auxiliaries = [
  "autofill-browser.yml",
  "codeql.yml",
  "sync-target-security.yml",
];
describe("heavy auxiliary suites are CD concerns", () => {
  it("keeps push-to-main CD workflows off pull requests", () => {
    expect(cdPushMainOnly).toEqual(["cd-npm-cli.yml", "cd-pwa.yml"]);
    expect(cdPushMainOnly).not.toContain("cd-headless-browser-benchmark.yml");
    for (const name of cdPushMainOnly) {
      const workflow = readFileSync(
        join(root, ".github/workflows", name),
        "utf8",
      );
      expect(workflow).toMatch(
        /^ {2}push:\n(?: {4}.*\n)*? {4}branches: \[main\]/m,
      );
      expect(workflow).not.toMatch(/^ {2}pull_request:/m);
    }
  });

  it("inventories pull_request, push, and merge_group workflows", () => {
    const directory = join(root, ".github/workflows");
    const workflowsWithAutomaticPrPushOrMergeGroup = readdirSync(directory)
      .filter((name) => name.endsWith(".yml"))
      .filter((name) =>
        /^ {2}(?:pull_request|pull_request_target|push|merge_group):/m.test(
          readFileSync(join(directory, name), "utf8"),
        ),
      )
      .sort();
    // The benchmark workflow on main is dispatch-only, so it is omitted.
    // cd-ghcr-publish.yml joins this list when that workflow file lands.
    expect(workflowsWithAutomaticPrPushOrMergeGroup).toEqual([
      "cd-npm-cli.yml",
      "cd-npm-publish-proof.yml",
      "cd-promotion-gates-proof.yml",
      "cd-pwa-profile-proof.yml",
      "cd-pwa.yml",
      "ci-advisory.yml",
      "ci-grok-commits.yml",
      "ci.yml",
    ]);
    const ci = readFileSync(join(directory, "ci.yml"), "utf8");
    expect(ci).toContain("name: CI");
    expect(ci).not.toMatch(/packages:\s*write/);
  });

  it.each(auxiliaries)("retains candidate qualification in %s", (name) => {
    const workflow = readFileSync(
      join(root, ".github/workflows", name),
      "utf8",
    );
    expect(workflow).toContain("  workflow_call:");
    expect(workflow).toMatch(
      /source_sha:\n(?:[^\n]*\n){0,3}[^\n]*required: true/,
    );
    expect(workflow).not.toMatch(
      /^ {2}(?:pull_request|pull_request_target|push|merge_group):/m,
    );
    expect(workflow).toContain("ref: ${{ inputs.source_sha");
  });

  it("keeps drafts failing all three required CI reporters", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(
      ci.match(/DRAFT: \$\{\{ needs.changes.outputs.draft \}\}/g),
    ).toHaveLength(3);
    expect(
      ci.match(/run: node scripts\/lib\/ci-required-result.mjs/g),
    ).toHaveLength(3);
    expect(ci).toContain(
      "draft: ${{ github.event.pull_request.draft == true && 'true' || 'false' }}",
    );
  });

  it("runs this file from workflow-inventory-gate after npm ci", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const job = ci
      .split("\n  workflow-inventory-gate:\n")[1]
      .split("\n  changes:\n")[0];
    expect(job).toContain("name: Workflow inventory");
    expect(job).toContain("needs: []");
    expect(job).toContain("timeout-minutes: 5");
    expect(job).toContain("contents: read");
    expect(job).not.toMatch(/packages:\s*write/);
    expect(job).not.toMatch(/\n {4}if:/);
    expect(job).not.toContain("needs.changes.outputs.typescript");
    expect(job).toContain(trunkInventoryCommand);
    expect(job).not.toContain("npm run quality:test");
    const installAt = job.indexOf("run: npm ci");
    const gateAt = job.indexOf(trunkInventoryCommand);
    expect(installAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(installAt);
    const typescriptBuild = ci
      .split("\n  typescript-build:\n")[1]
      .split("\n  rust-build:\n")[0];
    expect(typescriptBuild).not.toContain(trunkInventoryCommand);
  });
});
