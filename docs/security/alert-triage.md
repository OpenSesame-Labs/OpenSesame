# Alert triage and response

Which security alert to fix first, how fast, and what to do when one fires. It follows GitHub's [Prioritizing Security Alert Remediation](https://learn.github.com/well-architected/application-security/recommendations/prioritizing-alerts) and is the response process SSDF practices RV.1 to RV.3 ask for ([conformance](ssdf-conformance.md)).

Product security events (an expiring certificate, a breached password) are a different feed: see [security alerting](../operators/security-alerting.md).

## Where alerts come from

| Source | Arrives as |
|---|---|
| A reporter | Private security advisory ([SECURITY.md](../../SECURITY.md)) |
| CodeQL, OSV-Scanner, Scorecard | Code scanning alerts, from the weekly run and each release candidate |
| Dependabot | Dependabot alerts and security-update pull requests |
| GitHub secret scanning, gitleaks, Betterleaks | Secret scanning alerts; a red weekly run |
| `npm audit signatures` | A red weekly run |
| A local `npm run audit:*` gate | A failed hook or a failed release qualification |

## Order of work

Use the metadata GitHub already attaches before adding any of our own.

1. **A valid secret.** If the provider confirms it is active, or validity is unknown and the pattern is a provider's, treat it as compromised now. A confirmed-inactive secret goes to the back.
2. **Critical or high severity in code that ships.** For a dependency: a direct, runtime dependency with a patch available and a high EPSS score comes first. A development-only or transitive dependency with no fix comes later but is not dismissed.
3. **Anything in a surface below marked critical.**
4. **Everything else by severity, oldest first.** Many open medium alerts add up to a larger attack surface; do not let them accumulate.

An alert with a one-click fix is not more important because it is easy. Do the important ones first.

### What "critical surface" means here

The recommendation adds organizational context through repository custom properties. There is one product repository, so the context is per path instead:

| Surface | Why it is critical |
|---|---|
| `crates/gateway`, `crates/daemon`, `crates/worker` | Authorization decisions and credential resolution |
| `packages/control-plane`, `packages/os-domain` | Identity, OIDC, principals |
| `crates/client-core`, vault and key code under `packages/app-core` | Vault keys and end-to-end encryption |
| `apps/browser-extension` | Fills credentials into pages |
| `.github/`, `ops/github/`, `scripts/release/` | Decides what is published |

The Pages PWA and the Identity API are Internet-facing. A finding reachable from either without authentication moves up one step.

## Response targets

Measured from the alert or report to a merged fix on `main`. Acknowledgement of an outside report follows [SECURITY.md](../../SECURITY.md).

| Class | Target |
|---|---|
| Valid leaked secret | Revoke and rotate the same day; then remove it and find how it got in |
| Critical | 7 days |
| High | 30 days |
| Medium | 90 days |
| Low | Next routine dependency pass |

A target that will be missed is said so on the alert, with the reason and a new date. The weekly [engineering system metrics](../contributing/engineering-system-metrics.md) report shows open code scanning alerts by severity and their median age.

## Runbooks

### A secret is exposed

1. Revoke or rotate it at the provider. Do this before anything else; removing it from the repository does not un-leak it.
2. Check the provider's logs for use since the exposing commit.
3. Remove it from the tree. History rewriting is a separate, deliberate decision.
4. Find how it passed the hooks, and fix that. If it was a fixture that only looks like a secret, add a reviewed, narrowly scoped exemption ([ADR 0219](../adr/0219-betterleaks-alongside-gitleaks.md)).

### A dependency is vulnerable

1. Confirm it is reachable: direct or transitive, runtime or development, which surface.
2. Take the fixed version. Review the update as any other ([dependency supply chain](dependency-supply-chain.md)); a security update skips the seven-day cooldown, not the review.
3. If there is no fix: remove the dependency, replace it, or record in the alert why the vulnerable path is unreachable. Do not add a scanner exception to get a gate green.

### Code scanning finds a vulnerability

1. Reproduce it or show why it cannot happen. Read the source-to-sink path.
2. Fix it with a regression test that fails without the fix.
3. Search for the same pattern elsewhere and add an ast-grep or Semgrep rule if it can recur.

### A workflow is compromised or a publish token is suspected

1. Disable the workflow and revoke the token.
2. Check recent releases against their attested provenance.
3. Follow the leaked-secret runbook for every secret the workflow could read.

### After the fix

Write the dated audit under [`audits/`](audits/README.md) and run `npm run docs:index`. Once the advisory is public, file the [root cause](../../.github/ISSUE_TEMPLATE/vulnerability-root-cause.yml) analysis: why it existed, where else the pattern was looked for, and which gate now prevents it.

## Dismissing an alert

Dismiss only with a reason that a later reader can check: the code path, the test, or the advisory text that shows it does not apply. "Won't fix" without a reason is not a disposition. Dismissed alerts are re-read when the surrounding code changes.

## What is not used

Security campaigns, organization-level custom properties and Dependabot auto-triage rules are aimed at many repositories and many teams. With one repository and one maintainer, the order above is the campaign.
