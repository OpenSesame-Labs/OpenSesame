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

Both packages publish at **`0.0.0-alpha.0`** on first release, then **`0.0.0-alpha.N+1`** by reading existing versions from the npm registry. The stage job dry-runs dist-tag **`alpha`**. **Preview** is an approval gate and does not publish. **Production** is the only registry publish, with dist-tag **`next`**, using OIDC trusted publishing (`--provenance`). Prereleases never receive **`latest`**, and CD never runs `npm dist-tag add`. Only that one publish wins; a version already on the registry is skipped and is not retagged.

## Workflows

| Workflow | Trigger | Environments |
| --- | --- | --- |
| `cd-npm-cli.yml` | `push` to `main` (CLI paths) / `workflow_dispatch` | **Preview** approval only; **Production** publishes **`next`** via OIDC |
| `cd-pwa.yml` | `push` to `main` (Pages paths) / `workflow_dispatch` | **Preview** approval only; **github-pages** deploy; **Production** verifies Pages and publishes **`next`** via OIDC |
| `cd-npm-publish-proof.yml` | pull requests touching npm CD | none (actionlint and alpha dry-run) |
| `cd-pwa-profile-proof.yml` | pull requests touching the install-profile proof | none (loopback Chromium screenshots) |
| `ci-advisory.yml` | PRs to `main` | none (advisory) |

`workflow_dispatch` input `dry_run: true` stops before the first gated environment (**Preview** for npm and PWA).

## OpenPacker mapping (abbreviated)

OpenPacker’s `trunk-gate`, `promote-*`, and single-scope `@openpacker/cli` publish were adapted to OpenSesame’s existing affected CI, **`@opensesame-labs`** npm scope, Tyler’s **Preview / Production / github-pages / copilot** environments, CLI npm CD plus Pages CD (GitHub Pages + npm tarball of the same build). Weekly candidate promotion (`release-weekly.yml`) remains for Linux kits and qualified Pages bytes until cutover.

## Operator-owned

Tyler configures environments, npm org **`@opensesame-labs`**, trusted publishers for Production OIDC (no Production `NPM_TOKEN`), merge-queue ruleset, and `PAGES_*` variables — see `github-setup-spec.json`.
