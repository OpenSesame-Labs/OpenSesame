# NIST SSDF conformance

How this repository meets each practice of the [NIST Secure Software Development Framework](https://csrc.nist.gov/pubs/sp/800/218/final) (SP 800-218 v1.1), following GitHub's [SSDF implementation scenario](https://learn.github.com/well-architected/scenarios/nist-ssdf-implementation). The decision to hold the engineering system to it is [ADR 0222](../adr/0222-github-well-architected-and-ssdf.md).

## Reading the status column

| State | Meaning |
|---|---|
| Enforced | A checked-in control, with a test or gate that fails when it is removed. |
| Declared | Written down under [`ops/github/`](../../ops/github/README.md). Live only after an administrator applies it and the verify command passes. |
| Owner setting | A GitHub setting only the organization owner can read or change. |
| Deviation | Deliberately different from the recommendation. The reason is given. |
| Gap | Not done. |
| Not applicable | Needs a product tier or team shape this repository does not have. |

"Declared" is not "live". To check the live state, an administrator runs:

```bash
node ops/github/governance.mjs --verify
node ops/github/security-settings.mjs --verify
```

## Prepare the organization (PO)

| Practice | Status | How |
|---|---|---|
| PO.1 Define security requirements | Enforced | Standing requirements are the merge-gating design rules in [AGENTS.md §5](../../AGENTS.md) and the ADRs they cite. A new requirement is filed with the [security requirement](../../.github/ISSUE_TEMPLATE/security-requirement.yml) form, which asks how it is verified and links the implementing work. |
| PO.2 Roles and responsibilities | Deviation | One maintainer ([GOVERNANCE.md](../../GOVERNANCE.md), [MAINTAINERS.md](../../MAINTAINERS.md)). [CODEOWNERS](../../.github/CODEOWNERS) routes review for security-sensitive paths. There are no teams, security managers or training programme to assign. |
| PO.3 Supporting toolchains | Enforced and Declared | Scanners and proof tools run as `npm run audit:*` gates ([tooling evaluation](tooling-evaluation.md)) and in [scheduled monitoring](../../.github/workflows/security.yml). Secret scanning, push protection, Dependabot alerts and immutable releases are declared in [`repository-security.json`](../../ops/github/repository-security.json). Candidate provenance is attested in [release qualification](../../.github/workflows/release-weekly-qualify.yml). |
| PO.4 Criteria for security checks | Declared | The [default-branch ruleset](../../ops/github/default-branch.json) names the required checks, reviews and signatures. Promotion criteria are in [CI and artifact promotion](../operators/ci-promotion.md). The ruleset does not require code scanning results: see PW.7. |
| PO.5 Secure environments | Enforced and Declared | GitHub-hosted runners by default. The [`release` environment](../../ops/github/release-environment.json) requires owner approval and deploys only from `main`; the pipeline reads the live environment before publishing and refuses if it is unprotected. Self-hosted runner: see PW.6. |

## Protect the software (PS)

| Practice | Status | How |
|---|---|---|
| PS.1 Protect code from tampering | Declared, with gaps | The [default-branch ruleset](../../ops/github/default-branch.json) requires a pull request, code-owner review, approval of the last push, dismissal of stale approvals, signed commits and linear history, and blocks force pushes and deletion. Every pull-request commit must be GitHub-verified and attributed ([check](../../.github/workflows/ci-grok-commits.yml)). **Owner setting:** two-factor authentication for the organization. **Not applicable:** SAML SSO, IP allow lists and enterprise-managed users (Enterprise only); push rulesets (not offered for public repositories). **Deviation:** agent commits are signed without a human gesture; the human decision is the merge. |
| PS.2 Verify release integrity | Enforced | The candidate builder attests provenance binding source, controller and payload; promotion verifies it before publishing ([ci-promotion](../operators/ci-promotion.md)). npm packages publish with `--provenance` ([action](../../.github/actions/publish-npm-package/action.yml)). Immutable releases are declared. |
| PS.3 Archive and protect releases | Declared, with a gap | Two [tag rulesets](../../ops/github/release-tags.json) restrict who may create, move or delete `v*` tags. **Gap:** no SBOM is generated in the release pipeline or attached to a release. `npm run generate:sbom` exists for local use, and the container builds set `sbom: false`. |

## Produce well-secured software (PW)

| Practice | Status | How |
|---|---|---|
| PW.1 Design to meet requirements | Enforced | [Threat model](threat-model.md) and its addenda; [security boundaries](security-boundaries.md); the [repository threat model](github-repository-threat-model.md) for the source-integrity side. Consequential decisions are ADRs. |
| PW.2 Review the design | Enforced | A consequential change carries an ADR in the same pull request ([pull request template](../../.github/pull_request_template.md)), reviewed with the code under the code-owner rule. |
| PW.4 Reuse well-secured software | Enforced and Declared | Mature libraries over hand-rolled protocol code ([ADR 0008](../adr/0008-better-auth-oidc-provider.md)). [Dependency review](../../.github/workflows/dependency-review.yml) reports advisories in what a pull request adds. Only listed, SHA-pinned actions may run ([declared](../../ops/github/repository-security.json), [tested](../../scripts/lib/github-security-settings.test.mjs)). See [dependency supply chain](dependency-supply-chain.md). |
| PW.5 Secure coding practices | Enforced | ast-grep, Semgrep, Clippy and the anti-slop lint as gates; the [exposure matrix](exposure-matrix.md); gitleaks and Betterleaks locally and over full history weekly. Push protection is declared. |
| PW.6 Secure build configuration | Enforced, with a deviation | Actions pinned to commit SHAs, no credentials persisted by checkout, per-job token permissions ([Actions security](actions-security.md)). **Deviation:** one optional self-hosted runner on this public repository, off by default and reachable only by the owner's own same-repository branches; the guard is tested. |
| PW.7 Review and analyze code | Deviation | Human review is declared in the ruleset. CodeQL runs weekly and against every release candidate ([workflow](../../.github/workflows/codeql.yml)), not on pull requests, and the ruleset does not require its results: scanning gates promotion, not merge ([ADR 0215](../adr/0215-trunk-builds-only.md), [ADR 0222 §6](../adr/0222-github-well-architected-and-ssdf.md)). |
| PW.8 Test executable code | Enforced, with a gap | Release qualification runs mutation, fuzzing, undefined-behaviour and the security suite on the frozen candidate ([checks](../../.github/workflows/ci-release-checks.yml)); `npm run test:redteam` and `npm run test:security` exercise the running system. **Gap:** published container images are not scanned as images. |
| PW.9 Secure defaults | Enforced | Experimental and risky features are off in [`.env.schema`](../../.env.schema); the hard rules are in [SECURITY.md](../../SECURITY.md). |

PW.3 was folded into PO.1 and PW.4 in SSDF v1.1.

## Respond to vulnerabilities (RV)

| Practice | Status | How |
|---|---|---|
| RV.1 Identify vulnerabilities continuously | Enforced, with a gap | [Weekly monitoring](../../.github/workflows/security.yml) uploads OSV and Scorecard results to code scanning, scans full history with gitleaks and Betterleaks, and verifies npm signatures. Reports arrive through private vulnerability reporting ([SECURITY.md](../../SECURITY.md)). **Gap:** no audit-log streaming to an external store. |
| RV.2 Assess, prioritize, remediate | Enforced | [Alert triage](alert-triage.md) sets the order and the response targets. Dependabot proposes fixes; a person reviews each. |
| RV.3 Root cause analysis | Enforced | Each fixed vulnerability gets a dated write-up under [`audits/`](audits/README.md). After disclosure, the [root cause](../../.github/ISSUE_TEMPLATE/vulnerability-root-cause.yml) form records why it existed and what prevents the next one. |

## Implementation checklist

The scenario's twenty items, in its order.

| Item | Status |
|---|---|
| Organization-level security policies and settings | Declared at repository level |
| Rulesets on the default branch | Declared |
| Code review approval before merging | Declared; one maintainer, see the deviations in [ADR 0222](../adr/0222-github-well-architected-and-ssdf.md) |
| Secret scanning and push protection | Declared; gitleaks and Betterleaks enforced |
| Dependabot alerts and security updates | Declared; version updates enforced in [`dependabot.yml`](../../.github/dependabot.yml) |
| Code scanning for vulnerable patterns | Enforced weekly and per release candidate |
| Dynamic and runtime security testing | Enforced in release qualification |
| Least-privilege CI build environments | Enforced |
| Required status checks for security scans | Deviation: scans gate promotion |
| OIDC between CI and cloud providers | Gap: there is no cloud provider. GHCR uses the job token. npm publishes by OIDC only when `NPM_TOKEN` is empty, and `RELEASE_PUBLISH_TOKEN` is long-lived |
| Role-based access with teams and custom roles | Not applicable: one maintainer |
| SAML SSO or OIDC for user authentication | Not applicable: Enterprise only |
| Audit log streaming | Gap |
| Vulnerability triage and remediation process | Enforced: [alert triage](alert-triage.md) |
| SBOMs for releases | Gap |
| Artifact attestations for build provenance | Enforced |
| Security requirements in Issues | Enforced: issue form |
| Security policy and incident response | Enforced: [SECURITY.md](../../SECURITY.md), [alert triage](alert-triage.md) |
| Security training | Not applicable: no staff; contributors and agents read [AGENTS.md](../../AGENTS.md) |
| Threat modeling and design review | Enforced |

## Gaps, in the order worth closing

1. Remove `NPM_TOKEN` in favour of npm trusted publishing over OIDC, and replace `RELEASE_PUBLISH_TOKEN` with a short-lived credential.
2. Generate an SBOM for each release candidate and attest it alongside provenance.
3. Scan the published container images.
4. Stream the organization audit log somewhere it outlives GitHub's retention.
5. Apply and verify the declared settings, so "Declared" rows become live.
