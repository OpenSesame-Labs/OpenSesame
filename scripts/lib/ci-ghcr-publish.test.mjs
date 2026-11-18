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

/** Triggers, the 10 minute cap, concurrency, permissions and the publish switch. */
function assertTriggersAndPublishGuards() {
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
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.ref != 'refs\/heads\/main' && format\('cd-ghcr-publish-dispatch-\{0\}', github\.ref\) \|\| format\('cd-ghcr-publish-prod-\{0\}', github\.ref\)/,
  );
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /group: cd-ghcr-publish\s*$/m);
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
    /if: needs\.images\.result == 'success' && needs\['opensesame-amd64'\]\.result == 'success' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)\)/,
  );
  assert.match(workflow, /provenance: \$\{\{ env\.PUBLISH_GHCR == 'true' \}\}/);
  assert.match(workflow, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /GHCR_PUBLISH_TOKEN/);
  assert.match(workflow, /container-release/);
  assert.match(workflow, /ghcr\.io\/opensesame-labs/);
  assert.match(workflow, /:next/);
  assert.match(workflow, /:sha-/);
  assert.match(workflow, /:latest/);
}

/** The image matrix: per-image caches, amd64-only native images, and their ids. */
function assertImageMatrix() {
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
  const images = workflow.slice(
    workflow.indexOf("\n  images:\n"),
    workflow.indexOf("\n  opensesame-amd64:\n"),
  );
  assert.doesNotMatch(images, /id: opensesame-amd64\b/);
  assert.doesNotMatch(images, /ops\/compose\/Dockerfile/);
  assert.match(
    workflow,
    /name: opensesame\n {12}file: ops\/compose\/Dockerfile\n {12}platforms: amd64\n/,
  );
  assert.match(workflow, /web-pwa-tailscale-wasm:/);
  assert.match(workflow, /loadTailscaleAssets/);
  assert.match(workflow, /target: runtime-from-prebuilt\n/);
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
}

/** web-pwa builds its runtime target on amd64 from the tailscale artifact. */
function assertWebPwaAmd64Build() {
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
}

/** The manifest job waits for every image job and only runs on main or a tag. */
function assertManifestJob() {
  assert.match(workflow, /docker buildx imagetools create/);
  assert.match(workflow, /name: Manifest \$\{\{ matrix\.name \}\}/);
  assert.match(
    workflow,
    /needs: \[images, opensesame-amd64, web-pwa-tailscale-wasm, web-pwa-amd64\]/,
  );
  assert.doesNotMatch(workflow, /needs\['web-pwa-arm64'\]/);
  assert.match(
    workflow,
    /if: needs\.images\.result == 'success' && needs\['opensesame-amd64'\]\.result == 'success' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)\) && needs\['web-pwa-amd64'\]\.result == 'success'/,
  );
  assert.match(workflow, /if: needs\.images\.result == 'success'/);
}

/** The runner job that compiles the opensesame binary with pinned tools and caches. */
function assertRunnerRustBuild(rust) {
  assert.match(rust, /timeout-minutes: 10\n/);
  assert.match(
    rust,
    /bash scripts\/ci\/prepare-dbus\.sh "\$RUNNER_TEMP\/opensesame-dbus"/,
  );
  assert.match(rust, /source "\$RUNNER_TEMP\/opensesame-dbus\/env\.sh"/);
  assert.match(rust, /bash scripts\/lib\/install-mise-locked\.sh rust\n/);
  assert.match(
    rust,
    /uses: actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0\n/,
  );
  assert.match(rust, /path: ~\/\.local\/share\/mise\n/);
  assert.match(
    rust,
    /key: mise-v2-\$\{\{ runner\.os \}\}-rust-lock-\$\{\{ hashFiles\('mise\.toml', 'mise\.lock'\) \}\}\n/,
  );
  assert.match(rust, /mise-v2-\$\{\{ runner\.os \}\}-seed-main-rust-\n/);
  assert.match(rust, /mise-v1-linux-\n/);
  assert.doesNotMatch(rust, /jdx\/mise-action/);
  assert.doesNotMatch(rust, /actions\/cache\/save@/);
  assert.doesNotMatch(rust, /install_args:/);
  assert.doesNotMatch(rust, /\n\s+cache: false\n/);
  assert.match(
    rust,
    /Swatinem\/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2/,
  );
  assert.match(rust, /prefix-key: v0-rust\n/);
  assert.match(rust, /shared-key: ghcr-opensesame-amd64\n/);
  assert.match(rust, /cache-on-failure: true\n/);
  assert.match(
    rust,
    /save-if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main' \}\}\n/,
  );
  assert.match(
    rust,
    /workspaces: \. -> \.\.\/\.\.\/\.\.\/\.cache\/packages\/cargo-target\n/,
  );
  assert.match(rust, /name: Install mold and clang\n/);
  assert.match(rust, /command -v mold/);
  assert.match(rust, /command -v clang/);
  assert.match(
    rust,
    /\[\[ -e "\$link_root\/bin\/ld\.mold" \|\| -e "\$link_root\/bin\/mold" \]\][\s\S]*?LD_LIBRARY_PATH=\$\{joined\}/,
  );
  assert.doesNotMatch(rust, /\bsudo\b/);
  assert.match(
    rust,
    /CARGO_INCREMENTAL: "0"\n {10}CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16"\n {10}CARGO_PROFILE_RELEASE_DEBUG: "0"\n {10}CARGO_PROFILE_RELEASE_STRIP: symbols\n {10}RUSTFLAGS: "-C link-arg=-fuse-ld=mold"\n/,
  );
  assert.equal(
    join(
      "/home/runner/work/OpenSesame-Labs/OpenSesame",
      "../../../.cache/packages/cargo-target",
    ),
    "/home/runner/.cache/packages/cargo-target",
  );
  assert.match(
    rust,
    /cargo build --release --locked -p opensesame-cli --bin opensesame\n/,
  );
  assert.doesNotMatch(rust, /cargo build --release -p opensesame-cli\n/);
  assert.match(rust, /name: opensesame-amd64-binary\n/);
  assert.match(
    rust,
    /path: \$\{\{ env\.CARGO_TARGET_DIR \}\}\/release\/opensesame\n/,
  );
  assert.doesNotMatch(rust, /path: target\/release\/opensesame\n/);
}

/** The image job that packages the prebuilt binary without compiling it again. */
function assertPrebuiltImageJob(image) {
  assert.match(image, /needs: opensesame-amd64-rust\n/);
  assert.match(image, /timeout-minutes: 10\n/);
  assert.match(image, /name: opensesame-amd64-binary\n/);
  assert.match(image, /path: ops\/compose\/prebuilt\n/);
  assert.match(image, /ops\/compose\/prebuilt\/opensesame/);
  assert.match(image, /file: ops\/compose\/Dockerfile\n/);
  assert.match(image, /target: runtime-from-prebuilt\n/);
  assert.match(image, /platforms: linux\/amd64\n/);
  assert.match(image, /cache-from: type=gha,scope=opensesame-amd64\n/);
  assert.match(image, /cache-to: type=gha,mode=max,scope=opensesame-amd64\n/);
  assert.doesNotMatch(image, /scope=\$\{\{ matrix\.id \}\}/);
  assert.match(image, /push: \$\{\{ env\.PUBLISH_GHCR == 'true' \}\}/);
  assert.match(image, /load: \$\{\{ env\.PUBLISH_GHCR != 'true' \}\}/);
  assert.match(
    image,
    /node scripts\/ci\/oci-image-smoke\.mjs opensesame:local/,
  );
  assert.doesNotMatch(image, /linux\/arm64/);
}

/** cargo-chef layering, the pinned Debian runtime and the BuildKit target cache. */
function assertCargoChefDockerfile(dockerfile) {
  assert.match(dockerfile, /cargo-chef/);
  assert.match(dockerfile, /cargo chef prepare/);
  assert.match(dockerfile, /cargo chef cook/);
  assert.match(
    dockerfile,
    /FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS debian-runtime\n/,
  );
  assert.match(dockerfile, /FROM debian-runtime AS runtime\n/);
  assert.match(dockerfile, /FROM debian-runtime AS runtime-from-prebuilt\n/);
  assert.doesNotMatch(dockerfile, /debian:bookworm-slim/);
  assert.equal(
    dockerfile.match(/--mount=type=cache,target=\/src\/target,sharing=locked/g)
      ?.length,
    2,
  );
  assert.match(
    dockerfile,
    /install -m 0755 target\/release\/opensesame \/usr\/local\/bin\/opensesame/,
  );
  assert.match(dockerfile, /COPY --from=builder \/usr\/local\/bin\/opensesame/);
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=builder \/src\/target\/release\/opensesame/,
  );
}

describe("GHCR publish workflow", () => {
  it("publishes from main and version tags and does not run on pull request", () => {
    assertTriggersAndPublishGuards();
    assertImageMatrix();
    assertWebPwaAmd64Build();
    assertManifestJob();
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
    assert.doesNotMatch(amd64, /runtime-from-prebuilt/);
    assert.doesNotMatch(workflow, /web-pwa-arm64/);
    assert.doesNotMatch(workflow, /docker load -i web-pwa/);
  });

  it("builds the opensesame binary on the runner and publishes runtime-from-prebuilt", () => {
    const rust = workflow.slice(
      workflow.indexOf("\n  opensesame-amd64-rust:\n"),
      workflow.indexOf("\n  images:\n"),
    );
    const image = workflow.slice(
      workflow.indexOf("\n  opensesame-amd64:\n"),
      workflow.indexOf("\n  # id: web-pwa-amd64\n"),
    );
    assertRunnerRustBuild(rust);
    assertPrebuiltImageJob(image);
    assert.doesNotMatch(rust, /timeout-minutes:\s*(?:45|120)/);
  });

  it("uses cargo-chef and BuildKit caches for the native host image", () => {
    const dockerfile = readFileSync(
      join(root, "ops/compose/Dockerfile"),
      "utf8",
    );
    assertCargoChefDockerfile(dockerfile);
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
