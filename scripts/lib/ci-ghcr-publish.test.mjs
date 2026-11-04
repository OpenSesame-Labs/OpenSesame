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
    assert.doesNotMatch(workflow, /opensesame-arm64/);
    assert.doesNotMatch(workflow, /web-pwa-arm64/);
    assert.doesNotMatch(workflow, /docker\/setup-qemu-action@/);
    assert.match(workflow, /runner: ubuntu-24.04-arm/);
    assert.doesNotMatch(workflow, /linux\/amd64,linux\/arm64/);
    assert.match(
      workflow,
      /id: opensesame-amd64\n {12}name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platform: linux\/amd64\n {12}runner: ubuntu-latest/,
    );
    assert.match(
      workflow,
      /name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platforms: amd64\n/,
    );
    assert.match(workflow, /web-pwa-tailscale-wasm:/);
    assert.match(workflow, /loadTailscaleAssets/);
    assert.doesNotMatch(workflow, /runtime-from-prebuilt/);
    assert.doesNotMatch(workflow, /web-pwa-amd64-runtime/);
    for (const id of [
      "cli-amd64",
      "cli-arm64",
      "web-pwa-amd64",
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
      /name: web-pwa\n {12}file: ops\/containers\/web-pwa\/Dockerfile\n {12}platforms: amd64\n/,
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
      workflow.indexOf("  web-pwa-amd64:"),
      workflow.indexOf("  manifests:"),
    );
    assert.match(webPwaAmd64, /needs: web-pwa-tailscale-wasm/);
    assert.match(webPwaAmd64, /web-pwa-tailscale-distributions/);
    assert.match(webPwaAmd64, /actions\/download-artifact@/);
    assert.match(webPwaAmd64, /target: runtime\n/);
    assert.match(webPwaAmd64, /platforms: linux\/amd64\n/);
    assert.match(webPwaAmd64, /cache-from: type=gha,scope=web-pwa-amd64\n/);
    assert.match(
      webPwaAmd64,
      /cache-to: type=gha,mode=max,scope=web-pwa-amd64\n/,
    );
    assert.doesNotMatch(webPwaAmd64, /PREBUILT_IMAGE/);
    assert.doesNotMatch(webPwaAmd64, /platforms: linux\/arm64/);
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
      /needs: \[images, web-pwa-tailscale-wasm, web-pwa-amd64\]/,
    );
    assert.doesNotMatch(workflow, /needs\['web-pwa-arm64'\]/);
    assert.match(
      workflow,
      /if: needs\.images\.result == 'success' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)\) && needs\['web-pwa-amd64'\]\.result == 'success'/,
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

  it("keeps web-pwa on amd64 and the tailscale artifact without an arm64 proof", () => {
    const amd64 = workflow.slice(
      workflow.indexOf("  web-pwa-amd64:"),
      workflow.indexOf("  manifests:"),
    );
    assert.ok(amd64.includes("needs: web-pwa-tailscale-wasm"));
    assert.match(amd64, /name: web-pwa-tailscale-distributions/);
    assert.match(amd64, /target: runtime\n/);
    assert.match(amd64, /platforms: linux\/amd64\n/);
    assert.doesNotMatch(amd64, /docker save/);
    assert.doesNotMatch(amd64, /actions\/upload-artifact@/);
    assert.doesNotMatch(amd64, /PREBUILT_IMAGE/);
    assert.doesNotMatch(amd64, /linux\/arm64/);
    assert.doesNotMatch(workflow, /web-pwa-arm64/);
    assert.doesNotMatch(workflow, /runtime-from-prebuilt/);
    assert.doesNotMatch(workflow, /docker load -i web-pwa/);
  });

  it("uses cargo-chef and BuildKit caches for the native host image", () => {
    const dockerfile = readFileSync(
      join(root, "ops/compose/Dockerfile"),
      "utf8",
    );
    assert.match(dockerfile, /cargo-chef/);
    assert.match(dockerfile, /cargo chef prepare/);
    assert.match(dockerfile, /cargo chef cook/);
    assert.equal(
      dockerfile.match(
        /--mount=type=cache,target=\/src\/target,sharing=locked/g,
      )?.length,
      2,
    );
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
