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

Both packages publish at **`0.0.0-alpha.0`** on first release, then **`0.0.0-alpha.N+1`** by reading existing versions from the npm registry. **Preview** publishes with dist-tag **`alpha`**; **Production** adds **`next`**. Prereleases never receive **`latest`**.

The build job uploads the npm tree, the Pages dist, and a release-metadata file. Preview and Production download those artifacts. They do not run `npm run build` again.

## Workflows

| Workflow | Trigger | What runs |
| --- | --- | --- |
| `cd-npm-cli.yml` | `push` to `main` (CLI paths) / `workflow_dispatch` | Stage once. Preview publishes **`alpha`** with no environment wait. **Production** adds **`next`**. |
| `cd-pwa.yml` | `push` to `main` (Pages paths) / `workflow_dispatch` | Four install profiles prove in parallel with the one Pages/npm build. A gate checks distinct hashes. Preview publishes **`alpha`** and deploys **github-pages** only after that gate, with no reviewer wait. **Production** downloads the same artifacts, verifies the live site, and adds **`next`**. |
| `ci-advisory.yml` | PRs to `main` | none (advisory) |

`github-pages` is the live Pages deployment, not the **Preview** environment. `actions/deploy-pages` preview mode is not public, so there is no second Pages environment. **Production** is the only required-reviewer gate. `workflow_dispatch` input `dry_run: true` stops after staging or the PWA build, before publish, Pages deploy, and Production.

Tyler removes the Preview required reviewers with the commands in `github-setup-spec.json` (`github_environment_changes_via_gh`). Production keeps its reviewer. Preview publish uses the repository `NPM_TOKEN` when that secret exists, otherwise OIDC trusted publishing.

## OpenPacker mapping (abbreviated)

OpenPacker’s `trunk-gate`, `promote-*`, and single-scope `@openpacker/cli` publish were adapted to OpenSesame’s existing affected CI, **`@opensesame-labs`** npm scope, Tyler’s **Preview / Production / github-pages / copilot** environments, CLI npm CD plus Pages CD (GitHub Pages + npm tarball of the same build). Weekly candidate promotion (`release-weekly.yml`) remains for Linux kits and qualified Pages bytes until cutover.

## Operator-owned

Tyler configures environments, `NPM_TOKEN`, npm org **`@opensesame-labs`**, trusted publishers, merge-queue ruleset, and `PAGES_*` variables — see `github-setup-spec.json`.

## Install caches

`ci.yml`, `cd-pwa.yml`, `cd-npm-cli.yml`, and `cd-npm-publish-proof.yml` restore an npm download cache and the mise tool cache. The Rust graph also uses `Swatinem/rust-cache`. `node_modules` is not cached. npm still checks the lockfile.

| Cache | Path | Key |
| --- | --- | --- |
| npm download | `.npm-cache` (`NPM_CONFIG_CACHE`) | `npm-download-<runner.os>-<hashFiles('package-lock.json')>` with restore prefix `npm-download-<runner.os>-` |
| mise | mise-action default tool directory | prefix `mise-v1` (platform, mise file hash, `install_args` hash, 30-day period) |
| Rust | `Swatinem/rust-cache` v2 defaults | `save-if` follows `TRUSTED_CACHE_SAVE` |

`TRUSTED_CACHE_SAVE` is true for `merge_group`, `push` to `refs/heads/main`, and `workflow_dispatch` on `refs/heads/main`. Pull requests, including forks, restore and do not save. The npm save step sets `continue-on-error: true` so two jobs writing the same key do not fail the run.
