# ADR 0222 — The engineering system follows the NIST SSDF and the GitHub Well-Architected recommendations, and says where it does not

- **Status:** Accepted
- **Date:** 2026-11-10
- **Amends:** [ADR 0215](0215-trunk-builds-only.md) (two read-only pull-request workflows are added to the trunk inventory)
- **Builds on:** [ADR 0214](0214-trunk-ci-artifact-promotion.md) (candidates are promoted, not rebuilt), [ADR 0093](0093-structural-quality-gates.md) (the debt ledger only falls), [ADR 0220](0220-no-ai-harness-dotfiles-in-the-product-repo.md) (no AI-harness dotfiles)
- **Operating record:** [SSDF conformance](../security/ssdf-conformance.md), [GitHub Well-Architected application](../contributing/github-well-architected.md)

## Context

OpenSesame is an authorization fabric. People who adopt it ask how it is built before they ask what it does. The repository already carried most of the controls a secure development framework expects: pinned actions, signed commits, candidate promotion with provenance, a long list of audit gates. It had no single statement of which framework those controls answer to, which controls are only declared and not live, and which recommendations it deliberately does not follow.

Two outside references are adopted as that statement:

- the [NIST Secure Software Development Framework](https://csrc.nist.gov/pubs/sp/800/218/final) (SP 800-218), read through GitHub's [SSDF implementation scenario](https://learn.github.com/well-architected/scenarios/nist-ssdf-implementation);
- the GitHub Well-Architected [anti-patterns](https://learn.github.com/well-architected/scenarios/anti-patterns), productivity [design principles](https://learn.github.com/well-architected/productivity/design-principles), [effective CI](https://learn.github.com/well-architected/productivity/recommendations/effective-ci), [engineering system metrics](https://learn.github.com/well-architected/productivity/recommendations/engineering-system-metrics), the application-security [checklist](https://learn.github.com/well-architected/application-security/checklist) and its recommendations on the [developer workspace](https://learn.github.com/well-architected/application-security/recommendations/securing-developer-workspace), [dependency threats](https://learn.github.com/well-architected/application-security/recommendations/managing-dependency-threats), [alert prioritization](https://learn.github.com/well-architected/application-security/recommendations/prioritizing-alerts), [Actions security](https://learn.github.com/well-architected/application-security/recommendations/actions-security) and the [repository threat model](https://learn.github.com/well-architected/application-security/recommendations/threat-model), and the governance [checklist](https://learn.github.com/well-architected/governance/checklist).

Both assume a GitHub Enterprise organization with several maintainers and a security team. This repository is public, has one maintainer, and is written largely by coding agents. Some recommendations therefore cannot be met as written, and a few conflict with decisions already recorded here.

## Decision

### 1. Every practice has one of six recorded states

Each SSDF practice and each Well-Architected checklist item is recorded once, with its evidence, as one of:

| State | Meaning |
|---|---|
| Enforced | A checked-in control, with a test or gate that fails when it is removed. |
| Declared | A setting written down under `ops/github/`. It is live only after an administrator applies it and the verify command passes. |
| Owner setting | A GitHub setting that only the organization owner can read or change, and that no file here can express. |
| Deviation | Deliberately different from the recommendation, with the reason. |
| Not applicable | Depends on a product tier or a team shape this repository does not have. |

A declaration is never reported as a live control. A recommendation that is not followed is recorded as a deviation with its reason, not left out, and nothing is recorded as merely "not done".

### 2. GitHub settings are declared and verified, not clicked

Rulesets and environments were already declared in `ops/github/` and applied by `governance.mjs`. Repository security settings join them in `ops/github/repository-security.json`: secret scanning with push protection, Dependabot alerts and security updates, private vulnerability reporting, immutable releases, and the Actions policy (only listed actions, pinned to a full commit SHA, a read-only default token, approval before an outside contributor's workflow runs). `ops/github/security-settings.mjs` reads, applies and verifies them.

The allowed-actions list equals the set of action repositories the workflows use. A test fails when they differ, so adding an action is a reviewed change to the list in the same pull request.

### 3. A workflow grants nothing by default

Every workflow sets `permissions: {}` and every job declares its own. No workflow uses `pull_request_target`. A `workflow_run` trigger carries a branch filter. Text an outsider controls reaches a shell step through `env:` and is never interpolated into the script. `scripts/lib/workflow-security.test.mjs` enforces each rule and carries a negative control for each.

### 4. Installing a dependency runs none of its code

`.npmrc` sets `ignore-scripts=true`. Dependabot proposes a version only after it has been public for seven days, and nothing it proposes merges without review. The scheduled security workflow verifies registry signatures and provenance attestations for the whole locked tree.

### 5. Three read-only pull-request workflows are admitted to trunk

[ADR 0215](0215-trunk-builds-only.md) keeps tests and scans out of trunk admission. Three workflows are added to the pull-request inventory because their question only exists at review time or costs nothing to answer:

- `dependency-review.yml` reports advisories in the dependencies a pull request adds or changes. It runs only when a manifest, lockfile or workflow changes, checks out nothing, and takes seconds.
- `engineering-metrics.yml` runs on a pull request only when the collector itself changes, as a live self-test.
- `devcontainer.yml` runs only when the dev container, the toolchain pins or a setup script changes. It builds the container and runs its setup under the declared hardening, because a container that no longer sets up is found by the next person to open it, not by any other check.

None is a required check. None tests or deploys the product; the third builds only the developer container.

### 6. Security scanning gates promotion, not merge

The SSDF scenario recommends requiring code scanning results before a pull request merges. This repository does not. CodeQL, mutation, fuzzing and the security suite run against the frozen release candidate, and a failure stops that candidate from being published ([ADR 0215](0215-trunk-builds-only.md)). The control sits at the publication boundary instead of the merge boundary. This is a deviation, recorded as one.

### 7. The engineering system is measured weekly

The twelve engineering system metrics are collected from the GitHub API every week and written to a job summary and an artifact. The definitions, including what counts as a production deployment, live in `tools/metrics/engineering-system.json`. Developer-happiness metrics come from an issue form. The two financial metrics cannot be derived from a repository and are owner-supplied.

## Deviations this decision accepts

| Recommendation | What happens here | Why |
|---|---|---|
| Require code scanning results to merge | Scans gate release promotion | [ADR 0215](0215-trunk-builds-only.md); see §6 |
| Two human approvals on every change | The ruleset declares two approvals with an administrator bypass limited to pull requests | One maintainer. An approval nobody can give would stop all work or be fabricated |
| Commit signing that needs a human gesture | Agent commits are signed by harness-held keys; every pull-request commit must be GitHub-verified and attributed | Most commits are written by agents. The human decision is the merge |
| Never use a self-hosted runner on a public repository | One optional ARM64 runner, off unless a repository variable is set, reachable only by the owner's own same-repository branches | Build latency. The guard is tested |
| Dev containers for all development | The dev container is provided and hardened, and it is not mandatory | Cloud agents run in their own per-session sandboxes |
| Organization-level rulesets, security configurations, custom properties, security campaigns | Repository-level declarations | One product repository |

## Consequences

- A reader can see which controls are live, which are only declared, and which are missing, without reading workflow YAML.
- The declared security settings and the tightened default-branch expectations change nothing until an administrator applies them. Until then the conformance record says "Declared".
- A new action, a new pull-request-triggered workflow, or a workflow-level permission now fails a test and needs a deliberate edit.
- Contributors install dependencies with lifecycle scripts off. A package that genuinely needs its install script needs a recorded exception.
- The metrics report will show "no data" for developer happiness until someone files a pulse, and "not recorded" for the financial ratios until the owner supplies them.

## What remains with the owner

The four items first recorded as open are closed as far as a repository can
close them: a signed dependency inventory per candidate, a weekly scan of
every published image, a weekly record of settings that fails when one
changed, and publish credentials that announce themselves on every use.

What is left needs the owner's account, not a change here, and is listed with
its exact steps in [SSDF conformance](../security/ssdf-conformance.md#what-is-left-and-whose-it-is):
applying the declared settings, deleting `NPM_TOKEN` once npm trusted
publishing is configured, keeping the release token within 90 days, and
keeping a copy of the exported records outside GitHub.
