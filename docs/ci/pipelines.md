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

Both packages publish at **`0.0.0-alpha.0`** on first release, then **`0.0.0-alpha.N+1`** by reading existing versions from the npm registry. **Preview** publishes with dist-tag **`alpha`**; **Production** publishes **`next`** via OIDC. CD never runs `npm dist-tag add`. Prereleases never receive **`latest`**.

The build job uploads the npm tree, the Pages dist, and a release-metadata file. Preview and Production download those artifacts. They do not run `npm run build` again.

Promotion is automated: **main CI** (TypeScript, Rust, Bundle budgets on the same commit), **four-profile proof** (PWA CD), **preview publish and Pages deploy**, **preview smoke** (alpha npm resolves and `opensesame --version`; PWA CD also verifies the live Pages revision), then **Production** publishes **`next`** via OIDC. CD never runs `npm dist-tag add`. Any failure stops Production and posts a commit comment. No required reviewers on Preview or Production.

## Workflows

| Workflow | Trigger | What runs |
| --- | --- | --- |
| `cd-npm-cli.yml` | `push` to `main` (CLI paths) / `workflow_dispatch` | Main CI gate, stage once, Preview **`alpha`**, preview npm smoke, automatic Production **`next`**. |
| `cd-pwa.yml` | `push` to `main` (Pages paths) / `workflow_dispatch` | Main CI gate, four-profile proof, one Pages/npm build, Preview **`alpha`** and **github-pages** deploy, preview smoke, automatic Production **`next`**. |
| `cd-promotion-gates-proof.yml` | PR touching CD gate scripts / `workflow_dispatch` | Unit tests plus simulated smoke gate (`force_smoke_fail` proves a blocked promotion). |
| `cd-npm-publish-proof.yml` | pull requests touching npm CD | none (actionlint and alpha dry-run) |
| `cd-pwa-profile-proof.yml` | pull requests touching the install-profile proof | none (loopback Chromium screenshots) |
| `ci-advisory.yml` | PRs to `main` | none (advisory) |

`github-pages` is the live Pages deployment, not the **Preview** environment. `actions/deploy-pages` preview mode is not public, so there is no second Pages environment. **Production** is not a human approval gate; workflow jobs enforce promotion. `workflow_dispatch` input `dry_run: true` stops after staging or the PWA build, before publish, Pages deploy, and Production.

Environment protection uses main-only branch policies with no required reviewers (Preview, Production, github-pages). Preview publish uses the repository `NPM_TOKEN` when that secret exists, otherwise OIDC trusted publishing.

## OpenPacker mapping (abbreviated)

OpenPacker’s `trunk-gate`, `promote-*`, and single-scope `@openpacker/cli` publish were adapted to OpenSesame’s existing affected CI, **`@opensesame-labs`** npm scope, Tyler’s **Preview / Production / github-pages / copilot** environments, CLI npm CD plus Pages CD (GitHub Pages + npm tarball of the same build). Weekly candidate promotion (`release-weekly.yml`) remains for Linux kits and qualified Pages bytes until cutover.

## Operator-owned

Tyler configures environments, `NPM_TOKEN`, npm org **`@opensesame-labs`**, trusted publishers, merge-queue ruleset, and `PAGES_*` variables — see `github-setup-spec.json`.
