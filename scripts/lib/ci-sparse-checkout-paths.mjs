/**
 * Sparse-checkout path lists for the CI/CD proof workflows.
 * No-cone patterns: directories are root-relative (`scripts/lib`); a root file
 * uses a leading slash so it does not match every nested copy. A bare
 * `package.json` pattern is intentional: it matches every workspace manifest
 * so `npm ci` can resolve the lockfile without the rest of the source tree.
 */

/** Reporters that only execute scripts/lib/ci-required-result.mjs. */
export const SPARSE_CI_REPORTER = Object.freeze(["scripts/lib"]);

/**
 * Workflow inventory gate: manifests for `npm ci`, the vitest contract, and
 * the workflow files plus Dockerfile that contract reads.
 */
export const SPARSE_CI_GATE = Object.freeze([
  ".github/workflows",
  "scripts/lib",
  "scripts/ci",
  "/ops/compose/Dockerfile",
  "package.json",
  "/package-lock.json",
  "/mise.toml",
  "/mise.lock",
  "/pnpm-workspace.yaml",
]);

/** npm/cargo/turbo/docker build context for one proof job. */
export const SPARSE_WORKSPACE_BUILD = Object.freeze([
  ".github",
  "apps",
  "crates",
  "packages",
  "examples",
  "patches",
  "scripts",
  "tools",
  "ops",
  "spec",
  "marketplace",
  "tests",
  "/package.json",
  "/package-lock.json",
  "/mise.toml",
  "/mise.lock",
  "/pnpm-workspace.yaml",
  "/rust-toolchain.toml",
  "/Cargo.toml",
  "/Cargo.lock",
  "/turbo.json",
  "/biome.json",
  "/tsconfig.base.json",
  "/.env.schema",
  "/.dockerignore",
]);

/** Release scripts and mise, with no workspace install. */
export const SPARSE_CD_RELEASE_SCRIPT = Object.freeze([
  "scripts/lib",
  "scripts/release",
  "/mise.toml",
  "/mise.lock",
]);

/** Pages preview smoke: install plus the smoke and chrome helpers. */
export const SPARSE_CD_PWA_SMOKE = Object.freeze([
  "scripts/release",
  "scripts/lib",
  "scripts/ci",
  "apps/pages/scripts/duress",
  "package.json",
  "/package-lock.json",
  "/mise.toml",
  "/mise.lock",
]);

/** Composite npm publish action and the release scripts it sits beside. */
export const SPARSE_CD_PWA_PUBLISH = Object.freeze([
  "scripts/release",
  "scripts/lib",
  ".github/actions/publish-npm-package",
  "/mise.toml",
  "/mise.lock",
  "/package.json",
  "/package-lock.json",
]);

/** GHCR manifest job only tests that these Dockerfiles exist. */
export const SPARSE_GHCR_MANIFEST = Object.freeze([
  "/ops/compose/Dockerfile",
  "/ops/containers/cli/Dockerfile",
  "/ops/containers/web-pwa/Dockerfile",
  "/ops/containers/control-plane/Dockerfile",
]);

/** web-pwa-arm64: runtime-from-prebuilt + oci smoke only. */
export const SPARSE_GHCR_WEB_PWA_ARM64 = Object.freeze([
  "/ops/containers/web-pwa/Dockerfile",
  "scripts/ci",
]);

export const AFFECTED_GRAPH_HISTORY =
  "merge-base and name-only diffs for the affected graph need full history.";

/** Checkout steps in file order. `history` requires fetch-depth 0. */
export const PROOF_CHECKOUT_PLAN = Object.freeze({
  ".github/workflows/ci.yml": Object.freeze([
    Object.freeze({ paths: SPARSE_CI_GATE }),
    Object.freeze({
      paths: SPARSE_WORKSPACE_BUILD,
      history: AFFECTED_GRAPH_HISTORY,
    }),
    Object.freeze({
      paths: SPARSE_WORKSPACE_BUILD,
      history: AFFECTED_GRAPH_HISTORY,
    }),
    Object.freeze({
      paths: SPARSE_WORKSPACE_BUILD,
      history: AFFECTED_GRAPH_HISTORY,
    }),
    Object.freeze({ paths: SPARSE_CI_REPORTER }),
    Object.freeze({ paths: SPARSE_CI_REPORTER }),
    Object.freeze({ paths: SPARSE_CI_REPORTER }),
  ]),
  ".github/workflows/cd-pwa.yml": Object.freeze([
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_CD_PWA_PUBLISH }),
    Object.freeze({ paths: SPARSE_CD_PWA_SMOKE }),
    Object.freeze({ paths: SPARSE_CD_PWA_PUBLISH }),
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
  ]),
  ".github/workflows/cd-npm-cli.yml": Object.freeze([
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_CD_PWA_PUBLISH }),
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
    Object.freeze({ paths: SPARSE_CD_PWA_PUBLISH }),
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
  ]),
  ".github/workflows/cd-ghcr-publish.yml": Object.freeze([
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_GHCR_WEB_PWA_ARM64 }),
    Object.freeze({ paths: SPARSE_GHCR_MANIFEST }),
  ]),
});

export const PROOF_WORKFLOW_PATHS = Object.freeze(
  Object.keys(PROOF_CHECKOUT_PLAN),
);

export const TRUNK_INVENTORY_COMMAND =
  "npx vitest run scripts/lib/ci-container-build-pr.test.mjs scripts/lib/ci-sparse-checkout.test.mjs";

export function historyComment(reason) {
  return `# checkout-history: ${reason}`;
}
