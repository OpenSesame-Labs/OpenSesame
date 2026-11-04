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
    assert.match(workflow, /PUBLISH_GHCR:/);
    assert.match(workflow, /push: \$\{\{ env\.PUBLISH_GHCR == 'true' \}\}/);
    assert.match(workflow, /load: \$\{\{ env\.PUBLISH_GHCR != 'true' \}\}/);
    assert.match(workflow, /oci-image-smoke\.mjs/);
    assert.match(
      workflow,
      /if: needs\.images\.result == 'success' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)\)/,
    );
    assert.match(
      workflow,
      /provenance: \$\{\{ env\.PUBLISH_GHCR == 'true' \}\}/,
    );
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
    assert.doesNotMatch(workflow, /docker\/setup-qemu-action@/);
    assert.match(workflow, /runner: ubuntu-24.04-arm/);
    assert.doesNotMatch(workflow, /linux\/amd64,linux\/arm64/);
    assert.match(
      workflow,
      /id: opensesame-amd64\n {12}name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platform: linux\/amd64\n {12}runner: ubuntu-latest/,
    );
    assert.match(
      workflow,
      /id: opensesame-arm64\n {12}name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platform: linux\/arm64\n {12}runner: ubuntu-24.04-arm/,
    );
    assert.match(
      workflow,
      /name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platforms: amd64 arm64/,
    );
    assert.match(workflow, /web-pwa-tailscale-wasm:/);
    assert.match(workflow, /loadTailscaleAssets/);
    const nativeWebPwaArm = workflow.slice(
      workflow.indexOf("\n  web-pwa-arm64:\n"),
      workflow.indexOf("# id: web-pwa-arm64"),
    );
    assert.match(nativeWebPwaArm, /needs: web-pwa-tailscale-wasm/);
    assert.match(nativeWebPwaArm, /actions\/download-artifact@/);
    assert.match(nativeWebPwaArm, /web-pwa-tailscale-distributions/);
    assert.match(nativeWebPwaArm, /target: runtime\n/);
    assert.match(nativeWebPwaArm, /platforms: linux\/arm64\n/);
    assert.match(nativeWebPwaArm, /cache-from: type=gha,scope=web-pwa-arm64\n/);
    assert.match(
      nativeWebPwaArm,
      /cache-to: type=gha,mode=max,scope=web-pwa-arm64\n/,
    );
    assert.doesNotMatch(nativeWebPwaArm, /PREBUILT_IMAGE/);
    assert.doesNotMatch(nativeWebPwaArm, /scope=web-pwa-amd64/);
    assert.doesNotMatch(nativeWebPwaArm, /Require amd64 prebuilt image/);
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
    assert.match(
      workflow,
      /web-pwa-amd64:[\s\S]*?target: runtime\n[\s\S]*?platforms: linux\/amd64/,
    );
    assert.match(
      workflow,
      /web-pwa-arm64-proof:[\s\S]*?Require amd64 prebuilt image[\s\S]*?PREBUILT_IMAGE=\$\{\{ needs\['web-pwa-amd64'\]\.outputs\.primary \}\}/,
    );
    assert.match(
      workflow,
      /web-pwa-arm64-proof:[\s\S]*?target: runtime-from-prebuilt/,
    );
    const webPwaDockerfile = readFileSync(
      join(root, "ops/containers/web-pwa/Dockerfile"),
      "utf8",
    );
    assert.match(
      webPwaDockerfile,
      /ARG PREBUILT_IMAGE=scratch\nFROM --platform=\$BUILDPLATFORM/,
    );
    const webPwaAmd64 = workflow.slice(
      workflow.indexOf("web-pwa-amd64:"),
      workflow.indexOf("# id: web-pwa-arm64"),
    );
    assert.match(webPwaAmd64, /needs: web-pwa-tailscale-wasm/);
    assert.match(webPwaAmd64, /web-pwa-tailscale-distributions/);
    assert.doesNotMatch(
      webPwaAmd64,
      /web-pwa-amd64:[\s\S]*?build-args:[\s\S]*?PREBUILT_IMAGE/,
    );
    assert.match(webPwaDockerfile, /ARG PREBUILT_IMAGE=scratch/);
    assert.match(webPwaDockerfile, / AS runtime\n/);
    assert.doesNotMatch(
      webPwaDockerfile,
      /ARG PREBUILT_IMAGE\nFROM --platform=linux\/amd64 \$\{PREBUILT_IMAGE\}/,
    );
    assert.match(webPwaDockerfile, /--target runtime -t web-pwa:local \./);
    assert.match(workflow, /docker buildx imagetools create/);
    assert.match(workflow, /name: Manifest \$\{\{ matrix\.name \}\}/);
    assert.match(
      workflow,
      /needs: \[images, web-pwa-tailscale-wasm, web-pwa-amd64, web-pwa-arm64\]/,
    );
    assert.match(workflow, /if: needs\.images\.result == 'success'/);
  });

  it("does not push to ghcr.io from non-main refs", () => {
    assert.match(
      workflow,
      /github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    );
    assert.match(
      workflow,
      /if: steps\.dockerfile\.outputs\.present == 'true' && env\.PUBLISH_GHCR != 'true'/,
    );
    assert.match(
      workflow,
      /if: steps\.dockerfile\.outputs\.present == 'true' && env\.PUBLISH_GHCR == 'true'/,
    );
    assert.doesNotMatch(workflow, /\n\s*push: true\n/);
  });

  it("transfers the loaded amd64 web-pwa image to arm64 when not publishing", () => {
    const gate =
      "if: steps.dockerfile.outputs.present == 'true' && env.PUBLISH_GHCR != 'true'";
    const amd64 = workflow.slice(
      workflow.indexOf("  web-pwa-amd64:"),
      workflow.indexOf("# id: web-pwa-arm64"),
    );
    assert.match(amd64, /needs: web-pwa-tailscale-wasm/);
    assert.match(amd64, /web-pwa-tailscale-distributions/);
    const arm64 = workflow.slice(workflow.indexOf("# id: web-pwa-arm64"));
    const saveAt = amd64.indexOf(
      "docker save -o web-pwa-amd64-runtime.tar web-pwa:local",
    );
    const smokeAt = amd64.indexOf("name: Smoke image");
    const uploadAt = amd64.indexOf("actions/upload-artifact@");
    assert.ok(smokeAt >= 0 && saveAt > smokeAt);
    assert.ok(amd64.lastIndexOf(gate, saveAt) > smokeAt);
    assert.ok(uploadAt > saveAt);
    assert.ok(amd64.lastIndexOf(gate, uploadAt) > saveAt);
    assert.match(
      amd64,
      /uses: actions\/upload-artifact@[0-9a-f]{40} # v7\.0\.2/,
    );
    assert.match(
      amd64,
      /name: web-pwa-amd64-runtime\n {10}path: web-pwa-amd64-runtime\.tar/,
    );

    const downloadAt = arm64.indexOf("actions/download-artifact@");
    const loadAt = arm64.indexOf("docker load -i web-pwa-amd64-runtime.tar");
    const buildAt = arm64.indexOf("name: Build");
    assert.ok(downloadAt >= 0 && loadAt > downloadAt && buildAt > loadAt);
    assert.ok(arm64.lastIndexOf(gate, downloadAt) >= 0);
    assert.ok(arm64.lastIndexOf(gate, loadAt) > downloadAt);
    assert.match(arm64, /name: web-pwa-amd64-runtime/);
    assert.match(
      arm64,
      /driver: \$\{\{ env\.PUBLISH_GHCR == 'true' && 'docker-container' \|\| 'docker' \}\}/,
    );
    assert.match(
      arm64,
      /PREBUILT_IMAGE=\$\{\{ needs\['web-pwa-amd64'\]\.outputs\.primary \}\}/,
    );
    const localBuild = arm64.slice(arm64.indexOf("push: false"));
    assert.match(localBuild, /load: true/);
    assert.match(
      localBuild,
      /PREBUILT_IMAGE=\$\{\{ needs\['web-pwa-amd64'\]\.outputs\.primary \}\}/,
    );
  });

  it("uses cargo-chef and BuildKit caches for the native host image", () => {
    const dockerfile = readFileSync(
      join(root, "ops/compose/Dockerfile"),
      "utf8",
    );
    assert.match(dockerfile, /cargo-chef/);
    assert.match(dockerfile, /cargo chef prepare/);
    assert.match(dockerfile, /cargo chef cook/);
    assert.match(dockerfile, /type=cache,target=\/src\/target/);
    assert.match(
      dockerfile,
      /install -m 0755 target\/release\/opensesame \/usr\/local\/bin\/opensesame/,
    );
    assert.match(
      dockerfile,
      /COPY --from=builder \/usr\/local\/bin\/opensesame/,
    );
    assert.doesNotMatch(
      dockerfile,
      /COPY --from=builder \/src\/target\/release\/opensesame/,
    );
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
