# CI and CD pipelines

Trunk integration stays in `.github/workflows/ci.yml` (merge queue + required checks `TypeScript`, `Rust`, `Bundle budgets`). Two **npm** deployables and one **Pages** deployable use path-filtered CD workflows after `main` moves.

Machine-readable GitHub/npm setup: [`github-setup-spec.json`](github-setup-spec.json).

## npm packages (registry scope)

| Workspace (dev) | Published name | `bin` on npm |
| --- | --- | --- |
| `@opensesame/cli` (`packages/cli`) | **`@opensesame-labs/cli`** | **`opensesame`** |
| `@opensesame/pages` (`apps/pages`) | **`@opensesame-labs/web-pwa`** | **`opensesame-pages`** (serves bundled `dist/`) |

The `@opensesame` npm scope is unrelated; only **`@opensesame-labs/*`** is published. Staging scripts in `scripts/release/prepare-*-release.mjs` and `scripts/release/npm-publish-names.mjs` set `publishConfig.access: public` and `provenance: true`.

## npm versioning (trunk CD)

Both packages publish at **`0.0.0-alpha.0`** on first release, then **`0.0.0-alpha.N+1`** by reading existing versions from the npm registry. **Preview** publishes **`0.0.0-alpha.N`** with dist-tag **`alpha`**. **Production** rewrites that staged `package.json` to **`0.0.0-next.N`** (same numeric suffix) and publishes it with **`--tag next --provenance`** using the Production **`NPM_TOKEN`** (OIDC only when that token is empty). Prereleases never receive **`latest`**. Production does not run `npm dist-tag add`.

The build job uploads the npm tree, the Pages dist, and a release-metadata file. Preview and Production download those artifacts. They do not run `npm run build` again. The CLI stage build sets `CLI_RELEASE_PACK=1` so esbuild omits sourcemaps, and `prepare-cli-release.mjs` deletes `*.map` from the publish tree.

Promotion is automated: **main CI** (TypeScript, Rust, Bundle budgets on the same commit). On PWA CD the gate overlaps **Build full install profile dist** (built in `cd-pwa.yml`, optionally reusing a legacy main CI artifact when present), the Pages/npm **build**, and the fast **Build install profile (full)** screenshot job (reuses the uploaded dist; no Vite rebuild). **Preview smoke** for PWA CD runs pinned **[Hurl](https://hurl.dev/)** HTTP checks plus headless screenshots via `playwright-core` and chrome-headless-shell (`scripts/release/cd-pwa-preview-smoke/`). CLI CD still uses `cd-preview-smoke.mjs`. PWA CD uses concurrency group `cd-pwa` with `cancel-in-progress: false`. Then **Production** publishes **`0.0.0-next.N`** on **`next`**. Any failure stops Production and posts a commit comment. No required reviewers on Preview or Production.

## Workflows

| Workflow | Trigger | What runs |
| --- | --- | --- |
| `cd-npm-cli.yml` | `push` to `main` (CLI paths) / `workflow_dispatch` | Main CI gate and stage run together (stage does not wait). Preview **`alpha`** waits for both, then preview npm smoke and automatic Production publish of **`0.0.0-next.N`** on **`next`** (`NPM_TOKEN`, OIDC if empty). The gate job polls every 5s (`CI_GATE_ATTEMPTS` 475) and still requires TypeScript, Rust, and Bundle budgets on the same SHA. |
| `cd-pwa.yml` | `push` to `main` (Pages paths) / `workflow_dispatch` | Main CI gate, **full** install-profile proof overlapped with the one Pages/npm build, Preview **`alpha`** and **github-pages** deploy only after proof (reusing the staged artifacts), preview smoke, automatic Production publish of **`0.0.0-next.N`** on **`next`** (`NPM_TOKEN`, OIDC if empty). |
| `cd-promotion-gates-proof.yml` | PR touching CD gate scripts / `workflow_dispatch` | Unit tests plus simulated smoke gate (`force_smoke_fail` proves a blocked promotion). |
| `cd-headless-browser-benchmark.yml` | `workflow_dispatch`, weekly schedule, or PR touching only the benchmark workflow/script | Capped loopback screenshot matrix (`HEADLESS_BENCH_BACKENDS`, wall clock limit). **Not** a required check and **not** triggered by CD/PWA path filters. |
| `ci-advisory.yml` | PRs to `main` | none (advisory) |

`github-pages` is the live Pages deployment, not the **Preview** environment. `actions/deploy-pages` preview mode is not public, so there is no second Pages environment. **Production** is not a human approval gate; workflow jobs enforce promotion. `workflow_dispatch` input `dry_run: true` stops after staging or the PWA build, before publish, Pages deploy, and Production. A live blocked promotion on `main` uses `workflow_dispatch` with `proof_gate_fail: true` on `cd-pwa.yml` or `cd-npm-cli.yml`. That sets `CD_PROOF_GATE_FAIL=1`, and `cd-preview-smoke.mjs` throws `intentional promotion gate proof failure` so Production is skipped. See [post-2400 CD failures](post-2400-cd-failures.md).

Environment protection uses main-only branch policies with No required reviewers on Preview, Production, or github-pages. Preview publish jobs select environment **Preview** and use that environment's `NPM_TOKEN` when set (via `publish-npm-package`), otherwise OIDC trusted publishing under the same environment. Production selects the **Production** environment and passes that environment's `NPM_TOKEN` into `publish-npm-package` (OIDC trusted publishing only when the token is empty). Publisher rows and the incident RCA: `github-setup-spec.json` → `npm_trusted_publishing` and [post-2400-cd-failures.md](post-2400-cd-failures.md).

## OpenPacker mapping (abbreviated)

OpenPacker’s `trunk-gate`, `promote-*`, and single-scope `@openpacker/cli` publish were adapted to OpenSesame’s existing affected CI, **`@opensesame-labs`** npm scope, Tyler’s **Preview / Production / github-pages / copilot** environments, CLI npm CD plus Pages CD (GitHub Pages + npm tarball of the same build). Weekly candidate promotion (`release-weekly.yml`) remains for Linux kits and qualified Pages bytes until cutover.

## Operator-owned

Tyler configures environments, `NPM_TOKEN`, npm org **`@opensesame-labs`**, trusted publishers, merge-queue ruleset, and `PAGES_*` variables — see `github-setup-spec.json`.

## Install caches

`ci.yml`, `cd-pwa.yml`, `cd-npm-cli.yml`, and `cd-npm-publish-proof.yml` restore an npm download cache and the mise tool cache. The Rust graph also uses `Swatinem/rust-cache`. `node_modules` is not cached. npm still checks the lockfile.

| Cache | Path | Key |
| --- | --- | --- |
| npm download | `.npm-cache` (`NPM_CONFIG_CACHE`) | Primary `npm-download-v2-<runner.os>-lock-<hashFiles('package-lock.json')>`. Restore prefix `npm-download-v2-<runner.os>-seed-main-`. |
| mise | `~/.local/share/mise` | Primary `mise-v2-<runner.os>-<tool>-lock-<hashFiles('mise.toml','mise.lock')>`. Restore prefixes `mise-v2-<runner.os>-seed-main-<tool>-` and the historical main prefix `mise-v1-linux-`. mise-action stays `cache: true` with `cache_save: false` and a run-scoped key so it does not write. |
| Rust | `Swatinem/rust-cache` v2 | Primary `v0-rust-<job>-<os>-<arch>-<env>-<lock>`. The action restore key drops the lock hash (`v0-rust-<job>-`). `save-if` is `TRUSTED_CACHE_SAVE` on rust-build shard 0 only. |

`TRUSTED_CACHE_SAVE` is true for `merge_group`, `push` to `refs/heads/main`, and `workflow_dispatch` on `refs/heads/main`. `MAIN_CACHE_SEED` is true only for `push` and `workflow_dispatch` of `refs/heads/main`, so the `seed-main` prefix is written from the default branch. Pull requests, including forks, restore and do not save. Each restore logs `primary key hit`, `restore-key fallback to main prefix`, or `miss` via `scripts/lib/ci-cache-seed.mjs`. Save steps set `continue-on-error: true` so two jobs writing the same key do not fail the run.

## Rust compile shards

`rust-build` splits the selected crates across four hosted runners. The union is the same set `cargo build --locked --workspace` (or the affected `-p` list) compiles today. Crates that enable a feature on another workspace member stay on one shard. `CARGO_SHARD` unset still builds that whole set in one invocation. Empty shards are omitted and do not run a bare `cargo build`. The Bitwarden feature build stays on shard 0. The required check name stays **Rust**. `fail-fast` is false, and the reporter fails when any shard fails.

Shard 0 is the only leg that may save the Swatinem cache, and only when `TRUSTED_CACHE_SAVE` is true. Pull requests still do not save. Every shard restores `v0-rust-rust-build-`.

## Main CI wall time (push to main)

On #2426 (`3bf158652`), **Build affected TypeScript graph** ran (~2m54s) because CD-only paths under `apps/pages/scripts/duress/` and `scripts/release/cd-*` selected `@opensesame/pages`, and the job also built the full install-profile dist for CD. The **CI** workflow wall reached **3m28s** ([run 41575412832](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41575412832)) even though required reporter jobs only report compile success.

| | Commit / run | Build affected TypeScript graph | **CI workflow wall** |
| --- | --- | --- | --- |
| Before | `fd68fbef` [41569316856](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41569316856) | skipped | **~42s** |
| Regressed | `3bf158652` (#2426) [41575412832](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41575412832) | **2m54s** | **3m28s** |
| CD-only follow-up | `975ff9ffb` [41577060235](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41577060235) | skipped | **~32s** |

Trunk CI excludes CD-only paths from the TypeScript compile selector and keeps full-profile dist work in `cd-pwa.yml` only.

GitHub-hosted larger runners are not enabled. Tyler has not approved them. The opt-in in `ci.yml` is a comment and stays off (`ubuntu-latest-4-cores`, `ubuntu-latest-8-cores`). Public list prices for Linux x64, which are billed on public repositories: 4-core `linux_4_core` $0.012 per minute, 8-core `linux_8_core` $0.022 per minute. Standard `ubuntu-latest` is `actions_linux` at $0.006 per minute and is free on public repositories. Source: <https://docs.github.com/en/billing/reference/actions-runner-pricing>.

## tsgo typecheck benchmark

`scripts/ci/tsgo-benchmark.mjs` compares pinned TypeScript 7.0.2 `tsc` with `@typescript/native-preview` `tsgo`. Output matched on the local run (67 packages, script-sum baseline 31161 ms, candidate 28987 ms). That sum is not a CI job. The preview is an older native build, so `turbo run typecheck` stays on `tsc`.

CI wall time from `gh run view` on the pull request checks. Neither check selected TypeScript packages, so **Build affected TypeScript graph** was skipped.

| | Run | TypeScript | Rust | Bundle budgets | Affected build graph |
| --- | --- | --- | --- | --- | --- |
| Before | [41559786830](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41559786830) (PR #2412) | 9s | 7s | 10s | 14s |
| After | [41559897362](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41559897362) (PR #2409) | 8s | 8s | 9s | 12s |

## Headless browser benchmark (optional)

The benchmark compares install and three-screenshot capture time for CD headless stacks. It is **not** a merge gate (`ops/github/default-branch.json` required checks are TypeScript, Rust, and Bundle budgets only).

Before #2427 it ran on broad CD path filters (including `cd-pwa-preview-smoke/**`), so PWA CD pull requests paid for a ~7.7 minute job in parallel with required checks. #2427 removed it from those paths; this workflow runs only on `workflow_dispatch`, the weekly schedule, or pull requests that edit the benchmark files. The job caps backends (`system,cft,pw-hshell` by default) and `HEADLESS_BENCH_WALL_SEC`.

Parallel PR check wall (latest job finish minus push time on the same commit push):

| | Push | Slowest check | Wall |
| --- | --- | --- | --- |
| Before (#2426 era, `cursor/cd-pwa-proof-fast-ee3b`) | [41574322910](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41574322910) et al. | **Headless browser benchmark** 7m39s | **~7.7m** |
| After (#2427, `cursor/cd-pwa-proof-sharp-only-ee3b`, benchmark removed from CD paths) | [41577428442](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41577428442) et al. | CD PWA profile proof 5m45s (required CI ~48s) | **~5.8m** |

Target for required trunk checks alone remains under five minutes on typical CD-only diffs; optional CD proof workflows can run longer without blocking merge.

## Vitest isolation

`isolate: false` is not used. One local run of `npx vitest run` in `packages/app-core` with `isolate: false` and an `afterEach` that clears mocks, timers, stubs, and env overrides finished red: 27 files failed, 108 tests failed, and 4 unhandled errors in 443s (13415 tests passed). That 443s is the local process time, not a GitHub Actions job. Leaked state included a locked vault tomb, a guest principal left in place of `principal_1`, and a missing bearer token. The package config was reverted. The full `npm run test` suite was not switched over and was not run three times.

The pull request checks do not run Vitest. `gh run view` wall time on those checks, with **Build affected TypeScript graph** and **Build affected Rust graph** skipped on both:

| | Run | TypeScript | Rust | Bundle budgets | Affected build graph |
| --- | --- | --- | --- | --- | --- |
| Before | [41559897362](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41559897362) (PR #2409) | 8s | 8s | 9s | 12s |
| After | [41560110820](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41560110820) (PR #2410) | 8s | 11s | 11s | 14s |
