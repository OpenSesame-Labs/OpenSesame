# CI and CD pipelines

Trunk integration stays in `.github/workflows/ci.yml` (merge queue + required checks `TypeScript`, `Rust`, `Bundle budgets`). Two **npm** deployables and one **Pages** deployable use path-filtered CD workflows after `main` moves.

Machine-readable GitHub/npm setup: [`github-setup-spec.json`](github-setup-spec.json).

## npm packages (registry scope)

| Workspace (dev) | Published name | `bin` on npm |
| --- | --- | --- |
| `@opensesame/cli` (`packages/cli`) | **`@opensesame-labs/cli`** | **`opensesame`** |
| `@opensesame/env-spec-bridge` (`packages/env-spec-bridge`) | **`@opensesame-labs/env-spec-bridge`** | **`opensesame-env-parse`** |

The `@opensesame` npm scope is unrelated; only **`@opensesame-labs/*`** is published. Staging scripts in `scripts/release/prepare-*-release.mjs` and `scripts/release/npm-publish-names.mjs` set `publishConfig.access: public` and `provenance: true`.

## Workflows

| Workflow | Trigger | Environments |
| --- | --- | --- |
| `cd-npm-cli.yml` | `push` to `main` (CLI paths) / `workflow_dispatch` | **Preview** → publish `preview` dist-tag; **Production** → move `latest` |
| `cd-npm-env-spec-bridge.yml` | `push` to `main` (env-spec paths) / `workflow_dispatch` | Same |
| `cd-pwa.yml` | `push` to `main` (Pages paths) / `workflow_dispatch` | **Preview** → **github-pages** deploy → **Production** verify |
| `ci-advisory.yml` | PRs to `main` | none (advisory) |

`workflow_dispatch` input `dry_run: true` stops before the first gated environment (**Preview** for npm and PWA).

## OpenPacker mapping (abbreviated)

OpenPacker’s `trunk-gate`, `promote-*`, and single-scope `@openpacker/cli` publish were adapted to OpenSesame’s existing affected CI, **`@opensesame-labs`** npm scope, Tyler’s **Preview / Production / github-pages / copilot** environments, and dual npm pipelines plus Pages CD. Weekly candidate promotion (`release-weekly.yml`) remains for Linux kits and qualified Pages bytes until cutover.

## Operator-owned

Tyler configures environments, `NPM_TOKEN`, npm org **`@opensesame-labs`**, trusted publishers, merge-queue ruleset, and `PAGES_*` variables — see `github-setup-spec.json`.
