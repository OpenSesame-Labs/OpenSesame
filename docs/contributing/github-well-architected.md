# GitHub Well-Architected, applied

How this repository applies the GitHub Well-Architected recommendations it has adopted ([ADR 0222](../adr/0222-github-well-architected-and-ssdf.md)), item by item, with what is done, what is declared and what is not. The security practices are recorded against the NIST SSDF in [SSDF conformance](../security/ssdf-conformance.md); this page covers the rest and links the security pages.

Status words: **Enforced** (a checked-in control with a failing test or gate), **Declared** (written under [`ops/github/`](../../ops/github/README.md), live once applied and verified), **Owner setting**, **Deviation**, **Gap**, **Not applicable**. Definitions are in [SSDF conformance](../security/ssdf-conformance.md#reading-the-status-column).

| Recommendation | Recorded in |
|---|---|
| [NIST SSDF implementation](https://learn.github.com/well-architected/scenarios/nist-ssdf-implementation) | [SSDF conformance](../security/ssdf-conformance.md) |
| [Anti-patterns](https://learn.github.com/well-architected/scenarios/anti-patterns) | [Below](#anti-patterns) |
| [Productivity design principles](https://learn.github.com/well-architected/productivity/design-principles) | [Below](#productivity-design-principles) |
| [Effective CI](https://learn.github.com/well-architected/productivity/recommendations/effective-ci) | [Below](#effective-ci) |
| [Engineering system metrics](https://learn.github.com/well-architected/productivity/recommendations/engineering-system-metrics) | [Engineering system metrics](engineering-system-metrics.md) |
| [Application security checklist](https://learn.github.com/well-architected/application-security/checklist) | [Below](#application-security-checklist) |
| [Securing developer workspace](https://learn.github.com/well-architected/application-security/recommendations/securing-developer-workspace) | [Developer workspace](../security/developer-workspace.md) |
| [Dependency supply chain attacks](https://learn.github.com/well-architected/application-security/recommendations/managing-dependency-threats) | [Dependency supply chain](../security/dependency-supply-chain.md) |
| [Prioritizing alert remediation](https://learn.github.com/well-architected/application-security/recommendations/prioritizing-alerts) | [Alert triage](../security/alert-triage.md) |
| [Securing Actions workflows](https://learn.github.com/well-architected/application-security/recommendations/actions-security) | [Actions security](../security/actions-security.md) |
| [Repositories threat model](https://learn.github.com/well-architected/application-security/recommendations/threat-model) | [Repository threat model](../security/github-repository-threat-model.md) |
| [Governance checklist](https://learn.github.com/well-architected/governance/checklist) | [Below](#governance-checklist) |

## Productivity design principles

| Principle | How it shows up here |
|---|---|
| Design for automation | Standards are gates, not prose: `npm run lint`, `quality`, `audit:*`, and the hooks that run them. Security is automated early (hooks) and again at promotion. GitHub settings are declared and applied by script. |
| Design for integration | One entry point for agents and people ([AGENTS.md](../../AGENTS.md)); one definition for each tool version (`mise.toml`); reusable workflows and one composite action instead of copied YAML. |
| Design for continuous learning | Decisions are ADRs; every fixed vulnerability gets a dated audit and a root-cause form; skills under `skills/` are the shared how-to. |
| Design for feedback | Hooks answer in seconds, trunk CI only builds so it answers in minutes ([ADR 0215](../adr/0215-trunk-builds-only.md)), delivery qualification answers nightly. The [engineering pulse](../../.github/ISSUE_TEMPLATE/engineering-pulse.yml) form is the feedback channel on the system itself. |
| Design for engineering system success | The four zones are measured weekly ([engineering system metrics](engineering-system-metrics.md)); the structural debt ledger gives the baseline that may only improve. |
| Keep it simple | One native binary, one package manager, one toolchain file. A new top-level directory, a new pull-request workflow or a new action each needs a deliberate edit to a short list. |

## Effective CI

The recommendation's checklist, in its order.

| Item | Status | Here |
|---|---|---|
| Tests are isolated, deterministic and fast | Gap | No gate proves isolation or determinism. The Postgres suites create and drop their own database, and the flake rate in the weekly report is the signal. |
| Flaky tests are tracked and prioritized | Enforced | The weekly report shows the rerun-to-green rate. A flaky test is a bug with priority over new work. |
| Test execution is organized in clear groups | Enforced | Trunk builds; nightly dev runs the TypeScript and Postgres suites; prerelease runs browser, native and budgets; release runs mutation and security ([ci-promotion](../operators/ci-promotion.md)). |
| Error messages are clear and actionable | Enforced | Gates and hooks print the rule, the file and the fix; the workflow security test names the job, the step and the expression. |
| Fast checks gate expensive jobs; independent jobs run in parallel | Enforced | Lint, typecheck and static quality run in hooks before push. In `ci.yml` a change-detection job selects the affected graph and the build jobs fan out from it. |
| Dependencies are cached | Enforced | npm, Cargo and Turborepo caches, saved only from trusted refs ([CI cache](ci-cache.md)). |
| Job summaries and annotations give rich feedback | Gap | Jobs report through logs and `::error::` annotations. Only the metrics workflow writes a job summary. |
| Path filters and concurrency controls | Enforced | Workflows that can overlap carry a concurrency group. Required checks are never path-filtered: they always run and report, and decide inside the job what to build. |
| Least-privilege permissions | Enforced | [Actions security](../security/actions-security.md). |
| Third-party actions pinned to commit SHAs | Enforced | Same. |
| Dependabot keeps actions updated | Enforced | [`dependabot.yml`](../../.github/dependabot.yml). |
| OIDC for cloud authentication where possible | Gap | No cloud provider. npm uses OIDC only when `NPM_TOKEN` is empty. |
| Matrix builds across platforms and versions | Enforced | Native platform validation and CodeQL run as matrices. |
| Runtime environment customized to avoid repeated setup | Enforced | A locked mise bootstrap and caches. No custom runner image. |
| Reusable workflows standardize patterns | Enforced | Candidate build and each qualification tier are `workflow_call` workflows. |
| Workflow templates | Not applicable | One repository. |
| Monorepo builds only what is affected | Enforced | [ADR 0215](../adr/0215-trunk-builds-only.md). A shared input selects a full build. |
| Runner groups segment workloads | Not applicable | GitHub-hosted, plus one optional guarded runner. |
| Environment protection rules govern deployments | Declared | [`release-environment.json`](../../ops/github/release-environment.json). |
| CI metrics are tracked | Enforced | Duration, flake rate, queue time, first-attempt success and time to first feedback, weekly. |

## Anti-patterns

| Anti-pattern | How it is avoided |
|---|---|
| Fragmented organization structure | One organization, one product repository. |
| Vague requirements | Issue forms for bugs, features and security requirements ask for scope and verification. Consequential decisions are ADRs. Agents get domain terms and acceptance rules from [AGENTS.md](../../AGENTS.md), which `.github/copilot-instructions.md` points to. |
| Ineffective work management | Work is tracked as described in [Linear workflow](linear-workflow.md). The issue forms apply labels, and the security requirement form asks for the implementing pull requests. |
| Poor commit practices | One coherent slice per pull request, squash-merged, so `main` has one commit per change ([shipping](shipping.md)). Commit type prefixes are a convention, not a gate. |
| Inconsistent branching strategy | Trunk-based: short branches, stacked pull requests, no direct pushes, enforced by the ruleset. |
| Accumulating technical debt | The structural ledger may only fall ([ADR 0093](../adr/0093-structural-quality-gates.md)); a change that improves a file must tighten its recorded number. The total is in the weekly report. |
| Overengineering | Mature libraries over hand-rolled protocol code ([ADR 0008](../adr/0008-better-auth-oidc-provider.md)); the anti-slop lint; complexity budgets per function. |
| Bypassing code reviews | Review rules are declared in the ruleset. With one maintainer the administrator bypass is a recorded deviation, limited to pull requests. |
| Delayed feedback cycles | Trunk CI only builds. The weekly report lists ready pull requests older than three days and raises a warning. |
| Insufficient test automation | Unit, integration, browser, mutation and fuzz suites, with coverage floors for TypeScript and Rust. Delivery qualification runs them before a candidate is promoted. |
| Neglecting application security | [SSDF conformance](../security/ssdf-conformance.md). |
| Large releases | Nightly dev qualification and weekly release promotion of small immutable candidates. A new capability is off until an operator consents to it ([ADR 0130](../adr/0130-operator-controlled-capability-composition.md)), which separates shipping from activation. |
| Manual deployment processes | Promotion is automated end to end with one human approval on the `release` environment. The old manual publish workflows refuse to run. |
| Detecting PII with secret scanning custom patterns | Secret scanners here detect credentials only. No rule targets personal data, and none may be added: an alert stores what it finds and cannot be deleted. |

## Application security checklist

| Area | Status | Here |
|---|---|---|
| Dependency scanning | Enforced | OSV-Scanner, cargo-audit, cve-lite, dependency review, Dependabot. [Dependency supply chain](../security/dependency-supply-chain.md). |
| Code scanning | Enforced | CodeQL weekly and per release candidate; ast-grep and Semgrep gates. Not on pull requests: a recorded deviation. |
| Secrets management | Enforced | No live secret in the tree; `.env.schema`; publish tokens in environments. Rotation of those tokens has no recorded cadence: **Gap**. |
| Security policies | Enforced | [SECURITY.md](../../SECURITY.md), [AGENTS.md](../../AGENTS.md) §5 and §6. |
| Secure coding guidelines | Enforced | The design rules, checked by gates and by review. |
| Access controls | Owner setting | One maintainer. Access and installed apps are reviewed with the [repository threat model](../security/github-repository-threat-model.md). |
| Regulatory compliance | Not applicable | No regulatory regime is claimed for this repository. OpenSSF Scorecard and the [Best Practices badge](best-practices-badge.md) are the outside measures. |
| Audit logging | Gap | GitHub's audit log is not streamed or reviewed on a schedule. |
| Data protection | Enforced | The product stores nothing in the clear ([ADR 0149](../adr/0149-nothing-stored-in-the-clear.md)); logs carry no secrets ([ADR 0157](../adr/0157-logs-and-events-carry-no-secrets.md)). |
| Incident response plan | Enforced | [Alert triage](../security/alert-triage.md) runbooks. Not rehearsed: **Gap**. |
| Threat modeling | Enforced | [Threat model](../security/threat-model.md), its addenda, and the [repository threat model](../security/github-repository-threat-model.md). |
| Penetration testing | Enforced internally | `npm run test:redteam` and the fuzz and proof gates. No external test: **Gap**. |
| Security updates | Enforced | Dependabot weekly; base images and actions included. |
| Vulnerability management | Enforced | [Alert triage](../security/alert-triage.md). |
| Security monitoring | Enforced | [Weekly monitoring](../../.github/workflows/security.yml). |
| Training, phishing simulation, security champions | Not applicable | No staff. Contributors and agents read `AGENTS.md`. |
| Communication channels | Declared | Private vulnerability reporting, linked from the issue chooser and [SECURITY.md](../../SECURITY.md). |
| Repository structure, modularity, simplicity | Enforced | Package coupling, cycle and boundary gates in `npm run quality`; the [layout map](../architecture/layout-map.md). |
| Enterprise deployment items | Not applicable | SSO, SCIM, data residency, GitHub Enterprise Server. |

## Governance checklist

| Area | Item | Status | Here |
|---|---|---|---|
| Auditability | Branch rules, required checks, code review | Declared | [`default-branch.json`](../../ops/github/default-branch.json), verified with `governance.mjs --verify`. |
| Auditability | Compliance checks for code and dependencies | Enforced | Gates in hooks, trunk inventory, promotion. |
| Auditability | Audit logs retained and reviewed | Gap | Not streamed. |
| Auditability | Everything under version control | Enforced | Including the GitHub settings themselves. |
| Auditability | Custom properties | Not applicable | One repository. |
| Accountability | Roles defined and documented | Enforced | [GOVERNANCE.md](../../GOVERNANCE.md), [MAINTAINERS.md](../../MAINTAINERS.md), [CODEOWNERS](../../.github/CODEOWNERS). |
| Accountability | Process for requesting access | Enforced | By invitation after sustained contribution ([GOVERNANCE.md](../../GOVERNANCE.md)). |
| Accountability | Activity monitoring and alerts | Gap | Needs audit-log streaming. |
| Accountability | Incident response procedures | Enforced | [Alert triage](../security/alert-triage.md). |
| Adaptability | Policies reviewed and updated | Enforced | A policy change is an ADR and a pull request. |
| Adaptability | Training material current | Enforced | `AGENTS.md` and the skills are the material. They change by pull request, and skill copies are checked for drift. |
| Adaptability | Feedback mechanism | Enforced | The engineering pulse form and the weekly report. |
| Control | Periodic access reviews | Owner setting | No recorded cadence: **Gap**. |
| Control | Configuration management | Declared | [`ops/github/`](../../ops/github/README.md) with dry-run, apply and verify. |
| Control | Backup and recovery | Gap | Every clone holds full history and the settings can be re-applied from `ops/github/`, but recovery has not been rehearsed and issues and pull requests are not exported. |
| Control | Compliance audits | Enforced | This record, checked by [`engineering-system-docs.test.mjs`](../../scripts/lib/engineering-system-docs.test.mjs) so its evidence links cannot rot. |
