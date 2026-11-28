import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();
const workflow = readFileSync(
  join(root, ".github/workflows/cd-ghcr-publish.yml"),
  "utf8",
);
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

/** Proof triggers, budget and absence of registry authority. */
function assertTriggersAndPublishGuards() {
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\n/);
  assert.match(workflow, /cron: "17 11 \*\/3 \* \*"/);
  assert.match(workflow, /\n {2}schedule:\n {4}- cron: "17 11 \*\/3 \* \*"/);
  assert.match(
    workflow,
    /schedule runs on default branch only, proof-only \(publication-disabled\), no registry push/,
  );
  assert.doesNotMatch(workflow, /tags: \["v\*"\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  const timeouts = [...workflow.matchAll(/timeout-minutes:\s*(\d+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(timeouts)], ["10"]);
  assert.match(workflow, /ops\/containers\/\*\*/);
  assert.match(workflow, /ops\/compose\/Dockerfile/);
  assert.match(workflow, /group: ghcr-image-proof-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /packages:\s*write/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(
    workflow,
    /docker\/login-action|docker push|imagetools create/,
  );
  assert.match(workflow, /push: false/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /oci-image-smoke\.mjs/);
  assert.match(workflow, /GHCR publication disabled/);
}

/** The image matrix: per-image caches, amd64-only native images, and their ids. */
function assertImageMatrix() {
  for (const name of ["cli", "control-plane"]) {
    assert.match(workflow, new RegExp(`name: ${name}`));
  }
  assert.match(workflow, /opensesame-amd64:/);
  assert.match(workflow, /web-pwa-amd64:/);
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
  assert.match(workflow, /web-pwa-tailscale-wasm:/);
  assert.match(workflow, /loadTailscaleAssets/);
  const native = workflow.slice(
    workflow.indexOf("  web-pwa-tailscale-wasm:"),
    workflow.indexOf("  opensesame-amd64-rust:"),
  );
  const cachePath = "path: .cache/pwa-tailscale-native-http/distributions";
  const cacheKey =
    "key: pwa-native-distribution-${{ hashFiles('tools/pwa-tailscale-native-http/source.json', 'apps/pages/src/lib/capabilities/tailscale-artifacts.json') }}";
  assert.ok(ci.includes(cachePath) && ci.includes(cacheKey));
  assert.ok(native.includes(cachePath) && native.includes(cacheKey));
  const cacheAt = native.indexOf(
    "name: Restore the pinned native PWA distribution",
  );
  const verifyAt = native.indexOf(
    "name: Prepare pinned Tailscale native distributions",
  );
  assert.ok(cacheAt >= 0 && cacheAt < verifyAt);
  const restore = native.slice(cacheAt, verifyAt);
  assert.ok(restore.includes(cachePath) && restore.includes(cacheKey));
  assert.doesNotMatch(restore, /restore-keys:/);
  assert.match(
    restore,
    /uses: actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/,
  );
  const saveAt = native.indexOf(
    "name: Save the pinned native PWA distribution",
  );
  const uploadAt = native.indexOf("uses: actions/upload-artifact@");
  assert.ok(verifyAt < uploadAt && uploadAt < saveAt);
  const save = native.slice(saveAt);
  assert.ok(
    save.includes(
      "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && steps.native_cache.outputs.cache-hit != 'true'",
    ),
  );
  assert.ok(save.includes(cachePath) && save.includes(cacheKey));
  assert.doesNotMatch(save, /always\(\)|failure\(\)|continue-on-error/);
  assert.match(
    save,
    /uses: actions\/cache\/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/,
  );
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
    workflow.indexOf("  publication-disabled:"),
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
  assert.equal(
    rust.match(
      /Swatinem\/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2/g,
    )?.length,
    1,
  );
  assert.match(rust, /prefix-key: v0-rust\n/);
  assert.match(rust, /shared-key: ghcr-opensesame-amd64-musl\n/);
  assert.match(rust, /cache-all-crates: true\n/);
  assert.match(rust, /cache-on-failure: true\n/);
  assert.match(
    rust,
    /save-if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\) \}\}\n/,
  );
  assert.match(
    rust,
    /workspaces: \. -> \.\.\/\.\.\/\.\.\/\.cache\/packages\/cargo-target\n/,
  );
  assert.doesNotMatch(workflow, /rust-cache-trunk/);
  assert.doesNotMatch(workflow, /ghcr-opensesame-amd64-proof/);
  assert.match(rust, /id: rust-cache-ghcr\n/);
  assert.match(rust, /name: Log Rust cache hit\n/);
  assert.doesNotMatch(rust, /name: Log trunk/);
  assert.match(rust, /CACHE_NAME: rust-ghcr\n/);
  assert.match(
    rust,
    /CACHE_HIT: \$\{\{ steps\.rust-cache-ghcr\.outputs\.cache-hit \}\}\n/,
  );
  assert.match(rust, /CACHE_PRIMARY_KEY: v0-rust-ghcr-opensesame-amd64-musl\n/);
  assert.match(rust, /MAIN_SEED_PREFIX: v0-rust-ghcr-opensesame-amd64-musl-\n/);
  assert.equal(
    rust.match(/node scripts\/lib\/ci-cache-seed\.mjs\n/g)?.length,
    1,
  );
  assert.match(
    rust,
    /bash scripts\/ci\/prepare-musl\.sh "\$RUNNER_TEMP\/opensesame-musl"/,
  );
  assert.match(rust, /source "\$RUNNER_TEMP\/opensesame-musl\/env\.sh"/);
  assert.match(rust, /rustup target add x86_64-unknown-linux-musl\n/);
  assert.doesNotMatch(rust, /\bsudo\b/);
  assert.doesNotMatch(rust, /fuse-ld=mold/);
  assert.match(
    rust,
    /CARGO_INCREMENTAL: "0"\n {10}CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16"\n {10}CARGO_PROFILE_RELEASE_DEBUG: "0"\n {10}CARGO_PROFILE_RELEASE_STRIP: symbols\n/,
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
    /cargo build --release --locked -p opensesame-cli --bin opensesame --target x86_64-unknown-linux-musl\n/,
  );
  assert.ok(
    rust.indexOf('source "$RUNNER_TEMP/opensesame-musl/env.sh"') <
      rust.indexOf(
        "cargo build --release --locked -p opensesame-cli --bin opensesame --target x86_64-unknown-linux-musl",
      ),
  );
  assert.doesNotMatch(rust, /cargo build --release -p opensesame-cli\n/);
  assert.match(rust, /name: opensesame-amd64-binary\n/);
  assert.match(
    rust,
    /path: \$\{\{ env\.CARGO_TARGET_DIR \}\}\/x86_64-unknown-linux-musl\/release\/opensesame\n/,
  );
  assert.doesNotMatch(rust, /path: target\/release\/opensesame\n/);
  assert.doesNotMatch(
    rust,
    /path: \$\{\{ env\.CARGO_TARGET_DIR \}\}\/release\/opensesame\n/,
  );
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
  assert.match(image, /push: false/);
  assert.match(image, /load: true/);
  assert.match(
    image,
    /node scripts\/ci\/oci-image-smoke\.mjs opensesame:local/,
  );
  assert.doesNotMatch(image, /linux\/arm64/);
}

/** cargo-chef layering, the pinned Alpine runtime and the BuildKit target cache. */
function assertCargoChefDockerfile(dockerfile) {
  // Every `cargo install` names an exact version (Scorecard Pinned-Dependencies).
  assert.match(
    dockerfile,
    /cargo install cargo-chef --version \d+\.\d+\.\d+ --locked/,
  );
  for (const line of dockerfile.match(/cargo install[^\n]*/g) ?? []) {
    assert.match(line, /--version \d+\.\d+\.\d+/);
  }
  assert.match(dockerfile, /cargo chef prepare/);
  assert.match(dockerfile, /cargo chef cook/);
  assert.match(
    dockerfile,
    /FROM alpine:3\.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS alpine-runtime\n/,
  );
  assert.doesNotMatch(dockerfile, /apk add[^\n]*dbus-libs/);
  assert.match(dockerfile, /FROM alpine-runtime AS runtime\n/);
  assert.match(dockerfile, /FROM alpine-runtime AS runtime-from-prebuilt\n/);
  assert.doesNotMatch(dockerfile, /debian:bookworm-slim/);
  assert.equal(
    dockerfile.match(/--mount=type=cache,target=\/src\/target,sharing=locked/g)
      ?.length,
    2,
  );
  assert.equal(
    dockerfile.match(/--target x86_64-unknown-linux-musl/g)?.length,
    2,
  );
  assert.doesNotMatch(dockerfile, /gcompat/);
  assert.doesNotMatch(dockerfile, /fuse-ld=mold/);
  assert.match(
    dockerfile,
    /install -m 0755 target\/x86_64-unknown-linux-musl\/release\/opensesame \/usr\/local\/bin\/opensesame/,
  );
  assert.match(dockerfile, /COPY --from=builder \/usr\/local\/bin\/opensesame/);
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=builder \/src\/target\/release\/opensesame/,
  );
}

describe("GHCR image proof workflow", () => {
  it("builds proofs on main and manual dispatch without publishing", () => {
    assertTriggersAndPublishGuards();
    assertImageMatrix();
    assertWebPwaAmd64Build();
  });

  it("never pushes images on any ref", () => {
    assert.doesNotMatch(workflow, /PUBLISH_GHCR|GHCR_PUBLISH_TOKEN/);
    assert.doesNotMatch(workflow, /\n\s*push: true\n/);
    assert.match(workflow, /if: steps\.dockerfile\.outputs\.present == 'true'/);
  });

  it("keeps web-pwa on amd64 and the tailscale artifact without an arm64 proof", () => {
    const amd64 = workflow.slice(
      workflow.indexOf("  web-pwa-amd64:"),
      workflow.indexOf("  publication-disabled:"),
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

  it("builds the opensesame binary on the runner and tests runtime-from-prebuilt", () => {
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
