# Repository governance

This public organization repository merges through GitHub's native merge queue on
the default branch. "Require branch up to date" is off — the queue rebuilds each
entry against the tip of `main`. CODEOWNERS routes review without requiring the
sole owner to approve their own PR. Resolved review threads, signed commits,
squash-only linear history, blocked force pushes/deletion and all three named
Actions checks remain required. The one bypass actor is the repository admin
role, and only through a pull request: that is how the sole maintainer merges
a green pull request without a second reviewer. GitHub Actions (app ID
15368) must report `TypeScript`, `Bundle budgets`, and `Rust` on both
`pull_request` and `merge_group`; a third-party status with the same name cannot
satisfy them. See [merge queue](../docs/contributing/merge-queue.md).

Copilot review can be requested as an additional independent analysis, but it
does not supply a second human maintainer or automatically satisfy an approval
requirement. Add a real eligible reviewer before enabling mandatory approvals;
do not lock the sole maintainer out or fabricate approval records.

Two tag rulesets protect `refs/tags/v*` independently:

- `opensesame-release-tags` (`release-tags.json`) restricts updates and deletion
  to the repository admin (role 5). GitHub Actions has no mutation bypass.
- `opensesame-release-tag-creation` (`release-tag-creation.json`) restricts new
  tag creation to that admin and the GitHub Actions integration (app 15368).
  This lets the publisher reserve a tag naming the verified candidate using
  its job-scoped `GITHUB_TOKEN`, without receiving permission to move or delete
  an existing tag.

The creation exception identifies the Actions app, not one workflow. Any job
with repository contents-write permission could reserve a new version tag;
keep that permission narrowly scoped. The publisher independently validates
candidate/source identity and refuses occupied or moved tags. Tag restrictions
remain separate from the `release` environment: scheduled promotion executes
on `main`, not the tag. Main's ruleset keeps its single pull-request-only
admin bypass and gains no other.

`--apply` and `--verify` cover both named tag rulesets. On first activation,
apply bootstraps combined owner-only tag protection, installs the creation-only
exception, then removes creation from the original ruleset. During migration,
the original creation restriction remains until the new rule is installed.
Failure leaves the stronger restriction in place and verification fails. A
checked-in proposal or HTTP 403 is not activation: after an authorized admin
can apply settings, verify both live tag policies before release. GitHub documents that
[rulesets aggregate](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering),
that [creation, update and deletion restrictions require their own bypass](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and that [`GITHUB_TOKEN` authenticates as a GitHub App installation](https://docs.github.com/en/actions/concepts/security/github_token),
not as the owner who initiated the run.

`release-environment.json` and `release-environment-branches.json` are the concrete
proposed settings for that environment, not evidence of applied protection.
They require the repository owner to approve a release, allow the sole owner to
approve a run they initiated, restrict deployment to the `main` branch and disable admin
bypass. The owner ID is this repository's public GitHub owner ID. Do not apply
them to another repository or overwrite an existing environment's reviewers
without review. Activation requires explicit authorization for these exact
protections and repository-administration plus environment access. Checked-in
files do not establish live protection. The release pipeline reads the live
environment and main-only branch policy with `actions: read` before staging or
publishing. Missing, unprotected, mismatched or unreadable settings block
promotion; the pipeline never auto-configures protection. Apply the reviewed
settings through an authorized administrator and rerun the existing checks. Some
integrations can read settings but cannot change them; an HTTP 403 must never be reported as a successful apply.

```sh
node ops/github/governance.mjs --dry-run
node ops/github/governance.mjs --apply
node ops/github/governance.mjs --verify
```

Dry-run reads live state and prints the proposed changes; it writes nothing.
Apply requires repository-administration and environment permissions. It only
creates/updates the three named rulesets, preserves unrelated rulesets, enables
auto-merge, and restricts the existing github-pages environment to the current
default branch. Non-default branch/tag environment policies (including the
legacy gh-pages branch) are removed: manual deployment from them no longer
works. Existing environment reviewers/wait timers are preserved. A failed API
call fails the command; neither a checked-in spec nor a dry-run proves active
protection. Verification queries the resulting ruleset, branch and environment.

Break glass requires the owner to deliberately change the named ruleset using
GitHub administration, record the reason privately, and restore/verify it after
recovery. There is no always-on bypass. Do not disable checks just to merge a
failing PR. GitHub-squashed commits are signed by GitHub; direct local commits
must meet the repository's signature requirements if they reach main.

Actions pins were resolved from each upstream repository's existing major tag
using the GitHub commits API. The hermetic regression in
`scripts/lib/github-governance.test.mjs` runs under the existing quality job and
rejects unpinned actions and retained checkout credentials. It does not assert
that pinned third-party code is trustworthy or that branch policy fixes runtime
authorization defects. Full audits and model reviews remain private/local.

## Change alarm

The audit log cannot be streamed or queried from this repository, so a ruleset
that is disabled, an environment that loses its reviewer, a change of
visibility or an archived repository raised no alert. The `repository-settings`
job in `.github/workflows/security.yml` closes the part of that gap a
read-only token can reach. On every scheduled run it:

1. records the repository's visibility, archive and fork settings, whether the
   default branch is protected, every ruleset and every deployment environment
   with its reviewers, administrator bypass and branch policy
   (`scripts/security/settings-snapshot.mjs collect`);
2. lists live rulesets that differ from the three declared here, in the run
   summary (`declared`; informational, it never fails the run);
3. keeps the record as the `repository-settings` artifact for 90 days;
4. fails when the record differs from the previous one on the same branch,
   naming each setting with its value before and now (`compare`);
5. fails when any section could not be read (`readable`), because a section
   that is unreadable on every run would otherwise compare equal to itself
   and never raise the alarm.

The previous record is used only when this workflow's own scheduled run on the
same branch of this repository uploaded it. Any other workflow run, a fork's
pull request included, can upload an artifact under the same name; such a
record is passed over. A hand-started run records and compares, but its record
is never a baseline: otherwise anyone who can start the workflow could make a
changed setting the record the next scheduled run compares against.

The new record is kept before the comparison, so one change fails one
scheduled run and the next starts from the new state. A failed run is the
alert. GitHub sends a scheduled run's failure notification to the person who
last changed the workflow's schedule, so keep that person someone who acts on
it, or watch the run history. Treat it as a question, "did the owner make this
change?", and answer it before the next run clears it.

Limits, stated so the alarm is not read as more than it is:

- It sees a change at the next run, not when it happens, and not who made it.
  A setting changed and restored between two runs is not seen.
- The job's token is not shown ruleset bypass lists, secret names, the Actions
  policy, collaborators or installed apps. The record says "not visible" for a
  bypass list; the rest is absent. `governance.mjs --verify`, run by an
  administrator, covers the bypass lists.
- A section the token cannot read is recorded as unavailable, and the run
  fails for as long as it stays unreadable.
- The first scheduled run, and the first after 90 days without one, has
  nothing to compare with and only records. A run started by hand on a branch
  that has no scheduled runs only records too.

It reads; it never writes a setting.
