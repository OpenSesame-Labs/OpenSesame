# GitHub repository threat model

The [main threat model](threat-model.md) covers the running product. This page covers the repository itself: who could change what ships by attacking the source, its settings, or its automation. It applies GitHub's [repository threat model](https://learn.github.com/well-architected/application-security/recommendations/threat-model) to this repository, using the same actor and threat numbers.

Status words are defined in [SSDF conformance](ssdf-conformance.md). "Declared" means written under [`ops/github/`](../../ops/github/README.md) and live only once applied and verified.

## What we are working on

- A public repository in one organization, with one maintainer who holds the admin role.
- Many commits are written by coding agents. Changes merge by squash through a merge queue.
- GitHub Actions builds every change, qualifies candidates nightly and weekly, and publishes to npm, GHCR and GitHub Pages.
- Secrets read by workflows: `NPM_TOKEN`, `RELEASE_PUBLISH_TOKEN`, `TURBO_TOKEN`, `GITLEAKS_LICENSE`. The two publish tokens are read only in jobs bound to a deployment environment. GHCR publishes with the job token.

Trust boundaries: the maintainer's GitHub account; each agent harness and its signing key; the GitHub Actions app identity; third-party actions; package registries.

## Threat actors

| Id | Actor | Applies here |
|---|---|---|
| TA-01 | Anyone on the Internet | Yes. The repository is public. |
| TA-02 | Anyone with a GitHub account | Yes. Can fork and open a pull request. |
| TA-03 | An outside collaborator | None are granted access. |
| TA-04 | Someone holding the maintainer's GitHub credentials | Yes. The highest-impact actor: one account is the admin. |
| TA-05 | Someone holding an identity-provider session | Not applicable. No SSO in front of GitHub. |
| TA-06 | Someone holding a token or key authenticated to the organization | Yes. Includes an agent harness credential and the publish tokens. |
| TA-07 | A compromised third-party GitHub App | Yes, for each installed app. |
| TA-08 | A misconfigured or vulnerable Enterprise app | Not applicable. |
| TA-09 | An insider making a mistake | Yes. Includes an agent acting on a wrong or injected instruction. |

## Threats and what answers them

### T-01 Secrets found in the public repository

| Control | Status |
|---|---|
| gitleaks and Betterleaks gates locally, and over full history weekly ([workflow](../../.github/workflows/security.yml)) | Enforced |
| Tailscale key-material gate | Enforced |
| GitHub secret scanning with push protection ([declaration](../../ops/github/repository-security.json)) | Declared |
| Logs and events carry no secrets ([ADR 0157](../adr/0157-logs-and-events-carry-no-secrets.md)); configuration follows `.env.schema` | Enforced |
| A leaked secret is revoked and rotated first, then removed ([alert triage](alert-triage.md)) | Enforced |

### T-02 A private repository is read by someone unauthorized

Not applicable to the source: it is public by design. The equivalent risk is a private artifact becoming public, such as scanner output or an audit transcript. Scanner reports stay in private temporary directories and are not uploaded ([security workflow](../../.github/workflows/security.yml)); the [repository footprint](../contributing/repository-footprint.md) rules keep run histories and transcripts out of the tree.

### T-03 Danger-zone settings are changed

Visibility, ownership transfer, archiving, deletion, and disabling branch rules.

| Control | Status |
|---|---|
| Only the single admin can change them | Owner setting |
| Two-factor authentication on that account | Owner setting |
| Rulesets and security settings are declared, so drift is detectable with the verify commands | Declared |
| The release pipeline reads protection settings and never configures them | Enforced |
| Alerting on a settings change | Gap: needs audit-log streaming |

### T-04 History of an important branch is rewritten or deleted

| Control | Status |
|---|---|
| Force pushes and deletion blocked, linear history required on the default branch ([ruleset](../../ops/github/default-branch.json)) | Declared |
| `v*` tags cannot be moved or deleted except by the admin ([tag rulesets](../../ops/github/release-tags.json)) | Declared |
| Immutable releases | Declared |

### T-05 An unauthorized change reaches an important branch

| Control | Status |
|---|---|
| Pull request required; code-owner review; stale approvals dismissed; last push must be approved | Declared |
| Signed commits required; each pull-request commit must be GitHub-verified and attributed to a known agent or person ([check](../../.github/workflows/ci-grok-commits.yml)) | Enforced |
| Required checks must come from the GitHub Actions app, so a third-party status with the same name cannot satisfy them | Declared |
| CODEOWNERS covers workflows, governance, lockfiles, build inputs and security tooling ([file](../../.github/CODEOWNERS)) | Enforced |
| No outside collaborators | Owner setting |

### T-06 Someone approves and merges their own pull request

This is the residual risk of a single-maintainer project and is accepted, not solved. The ruleset declares two approvals and an administrator bypass limited to pull requests, so the maintainer can merge their own reviewed work but cannot push directly. What limits the damage:

- nothing merges without the required checks and signatures, bypass or not;
- publication is a second, separate approval on the `release` environment, which has no admin bypass ([declaration](../../ops/github/release-environment.json));
- the candidate that is published is the one that was qualified, proved by attested provenance.

Adding a second maintainer removes the bypass. Until then a compromised maintainer account (TA-04) can merge, and the publication approval is the last gate.

### T-07 The repository is compromised through elevated access or misconfiguration

| Control | Status |
|---|---|
| Declared settings with verify commands, so a missing protection is detectable | Declared |
| OpenSSF Scorecard weekly, published | Enforced |
| The Actions policy admits only listed, SHA-pinned actions and gives workflows a read-only default token | Declared |
| Installed GitHub Apps reviewed for least privilege | Owner setting |

### T-08 A workflow or action is exploited

| Control | Status |
|---|---|
| No `pull_request_target`; branch-filtered `workflow_run`; no untrusted text interpolated into a script | Enforced: [Actions security](actions-security.md) |
| `permissions: {}` at workflow level, declared per job | Enforced |
| Every external action pinned to a full commit SHA; checkout never persists credentials | Enforced |
| The self-hosted runner is reachable only by the owner's own same-repository branches | Enforced |
| CodeQL analyses the workflows themselves (`actions` language) | Enforced |
| Publish tokens are read only in environment-bound jobs; the `release` environment requires approval | Declared |
| Dependabot keeps actions current after a seven-day cooldown | Enforced |

## Did we do a good enough job?

Open against this model:

- A settings change raises no alert (T-03).
- One account can merge (T-06). Accepted, with the publication approval as the compensating control.
- The publish tokens are long-lived (TA-06). OIDC would remove them.
- "Declared" controls are not confirmed live from inside the repository.

Review this page when a maintainer is added, an app is installed, a secret is added, or a workflow gains a trigger.
