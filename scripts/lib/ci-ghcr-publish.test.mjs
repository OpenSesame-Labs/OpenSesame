import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { imageLeaf, probePlan } from "../ci/oci-image-smoke.mjs";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();
const workflow = readFileSync(
  join(root, ".github/workflows/cd-ghcr-publish.yml"),
  "utf8",
);
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

describe("GHCR publish workflow", () => {
  it("publishes from main and version tags and does not run on pull request", () => {
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /tags: \["v\*"\]/);
    assert.doesNotMatch(workflow, /pull_request/);
    assert.doesNotMatch(workflow, /continue-on-error/);
    const timeouts = [...workflow.matchAll(/timeout-minutes:\s*(\d+)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual([...new Set(timeouts)], ["10"]);
    assert.doesNotMatch(workflow, /timeout-minutes:\s*(?:45|120)/);
    assert.match(workflow, /ops\/containers\/\*\*/);
    assert.match(workflow, /ops\/compose\/Dockerfile/);
    assert.match(workflow, /\.github\/workflows\/cd-ghcr-publish\.yml/);
    assert.match(workflow, /group: cd-ghcr-publish/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /packages: write/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /attestations: write/);
    assert.match(workflow, /push: true/);
    assert.match(workflow, /provenance: true/);
    assert.match(workflow, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(workflow, /GHCR_PUBLISH_TOKEN/);
    assert.match(workflow, /container-release/);
    assert.match(workflow, /ghcr\.io\/opensesame-labs/);
    assert.match(workflow, /:next/);
    assert.match(workflow, /:sha-/);
    assert.match(workflow, /:latest/);
    for (const name of ["opensesame", "cli", "web-pwa", "control-plane"]) {
      assert.match(workflow, new RegExp(`name: ${name}`));
    }
    assert.match(workflow, /cache-from: type=gha,scope=\$\{\{ matrix\.id \}\}/);
    assert.match(
      workflow,
      /cache-to: type=gha,mode=max,scope=\$\{\{ matrix\.id \}\}/,
    );
    assert.match(workflow, /matrix\.platform == 'linux\/arm64'/);
    assert.equal(workflow.match(/docker\/setup-qemu-action@/g)?.length, 1);
    assert.doesNotMatch(workflow, /linux\/amd64,linux\/arm64/);
    assert.match(
      workflow,
      /id: opensesame-amd64\n {12}name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platform: linux\/amd64\n/,
    );
    assert.doesNotMatch(workflow, /opensesame-arm64/);
    for (const id of [
      "cli-amd64",
      "cli-arm64",
      "web-pwa-amd64",
      "web-pwa-arm64",
      "control-plane-amd64",
      "control-plane-arm64",
    ]) {
      assert.match(workflow, new RegExp(`id: ${id}\\b`));
    }
    assert.match(workflow, /docker buildx imagetools create/);
    assert.match(workflow, /name: manifest-\$\{\{ matrix\.name \}\}/);
  });

  it("is outside the required ci.yml graph and leaves the retired publisher alone", () => {
    assert.doesNotMatch(ci, /cd-ghcr-publish/);
    const retired = readFileSync(
      join(root, ".github/workflows/publish-containers.yml"),
      "utf8",
    );
    assert.match(retired, /workflow_dispatch:/);
    assert.doesNotMatch(retired, /packages:\s*write/);
    assert.doesNotMatch(retired, /docker\/build-push-action/);
  });
});

describe("oci image smoke", () => {
  it("classifies version and http probes", () => {
    assert.equal(imageLeaf("ghcr.io/opensesame-labs/cli:next"), "cli");
    assert.deepEqual(probePlan("ghcr.io/opensesame-labs/opensesame:sha-abc"), {
      kind: "version",
    });
    assert.equal(probePlan("web-pwa:local").port, 5180);
    assert.equal(probePlan("control-plane:local").optional, true);
    assert.equal(probePlan("control-plane:local").path, "/v1/health/live");
  });

  it("skips when docker is missing or no image was named", () => {
    const ran = spawnSync(
      process.execPath,
      [join(root, "scripts/ci/oci-image-smoke.mjs")],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(
      ran.stdout,
      /oci-image-smoke: (docker unavailable, skip|no image arguments, skip)/,
    );
  });
});
