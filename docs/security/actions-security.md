# GitHub Actions security

A CI system is remote code execution offered as a service. This page records how the workflows in [`.github/workflows/`](../../.github/workflows) follow GitHub's [Securing GitHub Actions Workflows](https://learn.github.com/well-architected/application-security/recommendations/actions-security), and what each rule protects.

The rules marked Enforced are checked by [`scripts/lib/workflow-security.test.mjs`](../../scripts/lib/workflow-security.test.mjs) and [`scripts/lib/github-governance.test.mjs`](../../scripts/lib/github-governance.test.mjs), which run in `npm run quality`. Each rule has a negative control proving the check can still fail.

## Rules for every workflow

| Rule | Why | Status |
|---|---|---|
| `permissions: {}` at workflow level. Every job declares its own. | A new job starts with no token permissions instead of inheriting someone else's. | Enforced |
| No blanket `read-all` or `write-all`. | A blanket grant hides what the job needs. | Enforced |
| No `pull_request_target`. | It runs with the base repository's secrets and write token; checking out the pull request then runs a stranger's code with them. | Enforced |
| A `workflow_run` trigger has a `branches` filter. | A run from any other branch must not start a privileged continuation. | Enforced |
| Untrusted text reaches a script through `env:`, never through `${{ }}` in the script body. | A pull-request title or branch name interpolated into a shell line is executed. | Enforced |
| Every external action is pinned to a full commit SHA, with the version in a comment. | A tag can be moved to malicious code; a SHA cannot. | Enforced |
| `actions/checkout` sets `persist-credentials: false`. | The token is not left in `.git/config` for later steps. | Enforced |
| The self-hosted runner label appears only behind the owner-only guard. | This repository is public, and a runner executes whatever a pull request contains. | Enforced |
| Only listed actions may run, and only SHA-pinned. The default token is read-only. Outside contributors need approval before their workflows run. | The platform refuses what review missed. | Declared in [`repository-security.json`](../../ops/github/repository-security.json) |

The untrusted contexts the check rejects in a script body are: issue, pull-request and discussion titles and bodies; comment and review bodies; commit messages and author fields; a pull request's head ref and label; a triggering run's head branch; `github.head_ref`; `github.ref_name`; and workflow inputs.

## Writing a workflow

```yaml
permissions: {}

jobs:
  example:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
      - name: Use contributor-written text
        env:
          TITLE: ${{ github.event.pull_request.title }}
        run: printf '%s\n' "$TITLE"
```

To add an action: resolve the commit SHA of a tagged release from the action's own repository, pin to it with the version in a comment, and add `owner/repository@*` to the allowed list in `repository-security.json`. The test names the missing entry.

A pull-request-triggered workflow must also be added to the trunk inventory in [`scripts/lib/ci-container-build-pr.test.mjs`](../../scripts/lib/ci-container-build-pr.test.mjs). That list is deliberately short ([ADR 0215](../adr/0215-trunk-builds-only.md)).

## How the recommendations map

| Recommendation | Here |
|---|---|
| Use OIDC for authentication | npm publishes with provenance and uses OIDC when `NPM_TOKEN` is empty. GHCR uses the job token. No cloud provider is deployed to. Remaining long-lived secrets are listed in the [repository threat model](github-repository-threat-model.md). |
| Configure repository rules | [Declared rulesets](../../ops/github/README.md): pull request, reviews, signed commits, required checks, no force push. |
| Least privilege for workflow permissions | Enforced as above. |
| Dependabot for the supply chain | The `github-actions` ecosystem is in [`dependabot.yml`](../../.github/dependabot.yml). Because actions are SHA-pinned, Dependabot raises version updates for them, not security alerts; the weekly update is the patch path. |
| Pin versions of actions | Enforced; SHA pinning is also required by the declared Actions policy. |
| Avoid actions with mutable dependencies | Reviewed when an action is added. The mise bootstrap used by the publish workflows downloads a pinned release and checks its SHA-256. |
| Avoid workflow injection | Enforced. |
| Avoid `pull_request_target` | Enforced. |
| Secure `workflow_run` | The two continuations are branch-filtered, check out the workflow's own commit, and validate the controller run and its artifact before using either. |
| Prefer `head.sha` over `head.ref` | Enforced: `head.ref` is in the rejected list. |
| Caution with public repositories | Fork pull requests get a read-only token and no secrets. The self-hosted runner guard is tested. Approval for outside contributors is declared. |
| Restrict allowed actions | Declared as policy as code; the list is tested against the workflows. |

## What the checks do not prove

They read YAML. They do not prove that a pinned action is trustworthy, that a script is free of injection through a file it reads, or that the declared platform policy is live. CodeQL's `actions` analysis and the weekly OpenSSF Scorecard run cover part of the first two; `node ops/github/security-settings.mjs --verify` covers the third.
