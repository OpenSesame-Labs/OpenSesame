/**
 * Sparse-checkout path lists for the CI/CD proof workflows.
 * No-cone patterns: directories are root-relative (`scripts/lib`); a root file
 * uses a leading slash so it does not match every nested copy. A bare
 * `package.json` pattern is intentional: it matches every workspace manifest
 * so `npm ci` can resolve the lockfile without the rest of the source tree.
 * A list that feeds `npm ci` also carries `/patches/vendor`: the lockfile
 * installs the patched dependency tarballs from there.
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
  "/patches/vendor",
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

/**
 * The opensesame GHCR job links `x86_64-unknown-linux-musl`. Cargo reads
 * `.cargo/config.toml` for the musl linker, so that root file is on this
 * checkout only.
 */
const SPARSE_OPENSESAME_RUST = Object.freeze([
  ...SPARSE_WORKSPACE_BUILD,
  "/.cargo/config.toml",
]);

/**
 * Pages image build runs the SAML worker freshness guard, which formats with
 * Biome. `biome.json` sets `vcs.useIgnoreFile`, so the Docker context needs
 * the root `.gitignore` beside `/biome.json`.
 */
const SPARSE_WEB_PWA_AMD64 = Object.freeze([
  ...SPARSE_WORKSPACE_BUILD.slice(
    0,
    SPARSE_WORKSPACE_BUILD.indexOf("/biome.json") + 1,
  ),
  "/.gitignore",
  ...SPARSE_WORKSPACE_BUILD.slice(
    SPARSE_WORKSPACE_BUILD.indexOf("/biome.json") + 1,
  ),
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
  "/patches/vendor",
]);

/** npm package proof and live Pages verification scripts. */
export const SPARSE_CD_NPM_PROOF = Object.freeze([
  "scripts/release",
  "scripts/lib",
  "/mise.toml",
  "/mise.lock",
  "/package.json",
  "/package-lock.json",
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
  ".github/workflows/cd-pwa-stranded-dispatch.yml": Object.freeze([
    Object.freeze({
      paths: [
        "scripts/lib",
        "scripts/release",
        "scripts/quality",
        ".github/workflows/cd-pwa.yml",
        "/mise.toml",
        "/mise.lock",
      ],
      history:
        "git diff from live Pages release.json revision to HEAD needs full history.",
    }),
  ]),
  ".github/workflows/cd-pwa.yml": Object.freeze([
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_CD_NPM_PROOF }),
    Object.freeze({ paths: SPARSE_CD_PWA_SMOKE }),
    Object.freeze({ paths: SPARSE_CD_PWA_SMOKE }),
    Object.freeze({ paths: SPARSE_CD_NPM_PROOF }),
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
  ]),
  ".github/workflows/cd-npm-cli.yml": Object.freeze([
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_CD_NPM_PROOF }),
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
    Object.freeze({ paths: SPARSE_CD_RELEASE_SCRIPT }),
  ]),
  ".github/workflows/cd-ghcr-publish.yml": Object.freeze([
    Object.freeze({
      paths: [
        ".github",
        "apps",
        "tools",
        "scripts",
        "/package.json",
        "/package-lock.json",
        "/mise.toml",
        "/mise.lock",
        "/patches/vendor",
      ],
    }),
    Object.freeze({ paths: SPARSE_OPENSESAME_RUST }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WORKSPACE_BUILD }),
    Object.freeze({ paths: SPARSE_WEB_PWA_AMD64 }),
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
