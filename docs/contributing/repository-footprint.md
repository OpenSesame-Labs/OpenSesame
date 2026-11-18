# Repository footprint

Keep the default branch a small, usable source checkout. Persist maintained
source, required fixtures, current approved evidence and concise findings.
Git history and PR discussions hold prior implementations and reviews.

## Enforced limits

`tools/quality/repository-size-policy.json` limits tracked content to **100 MiB**,
each file to **2 MiB**, and the checkout to **15,200 files**. This includes new
nonignored files and evidence. Compress or shorten media and remove superseded
content before adding more. Changes to these limits are explicit policy changes;
do not add a blanket allowlist to get a task through the gate.

The file limit reserves space for the maintained behavior models, model
configurations and regression suites used by the formal-verification workflow.
It remains a bound on the whole checkout, including those sources.

```bash
node scripts/quality/repository-size-gate.mjs
node scripts/dev/sync-agent-skills.mjs --check
```

The commit hook checks the actual Git index. Push, lint and CI checks cover the
working checkout. The gate rejects tracked caches, dependency/build directories,
raw review collections, per-run audit folders and the design artboards whose
source is already maintained. No dependency installation is needed to run it.

## Task output

Use ignored `work/<task>/` for ordinary scratch and private temporary storage
outside the checkout for sensitive scanner output. Reuse stable output slots;
do not append a dated or numbered history after each run. Raw review transcripts,
agent assignments and coverage ledgers remain temporary. Post concise conclusions
on the PR and update maintained findings in place with source/review references.
Clean only this task's scratch and build output after review. Never delete another
task's work, an active app's distribution, or a shared dependency/browser cache.

Approved implementation evidence additionally follows
[the evidence contract](../evidence/README.md). Before/after comparisons are
working material. Required test baselines are reviewed test inputs and live
with their tests, not in a screenshot history directory.

## Agent harnesses and installs

Harness dot folders are never tracked (see [agent setup](agent-setup.md)).
Third-party skills have one canonical local installation under the gitignored
`.agents/skills/`. Identical mirrors in `.claude/skills/` and `.grok/skills/`
use relative links;
intentional harness-specific files remain separate. First-party skills remain
in `skills/`. Install or update the canonical skill once, review it, then run
`node scripts/dev/sync-agent-skills.mjs` and its `--check` mode. The sync command
compares file bytes and executable modes before replacing duplicate paths.
Do not use multi-target copy installations or copy dependency trees to worktrees.

Session startup is lightweight. Dependency bootstrap requires explicit opt-in;
the installer fingerprints manifests, patches and lock/config inputs and reuses
a current install. Reuse npm's store, the shared Cargo target and installed
browsers. Database migration generation, baseline updates and scanner execution
are deliberate task commands, never startup side effects. Do not manually remove
packages from npm's dependency tree to reduce size; use a validated install
configuration when changing native-platform or tool profiles. The pinned npm run configuration selects the current OS, CPU and libc. The existing lockfile lacks
libc metadata; refresh that metadata with the normal registry available before
claiming the old GNU/musl duplication has been removed.

## Generated output and required history

For the five source-based design canvases, edit fragments/styles and regenerate
artboards locally before seeding. Reconcile editor changes back to those inputs;
do not commit generated copies. The five settings-connectivity artboards have
no equivalent generator and remain source inputs. See
[design tooling](../design/tooling.md).

Preserve migration snapshots, lockfiles, published contract artifacts, curated
fuzz regressions and active fixtures that have consumers. Minimize fuzz corpora
only after proving equivalent coverage. Preserve installer assets whose parity
checks require physical copies. Avoid unnecessary report files and duplicate
instructions: link this contract instead of copying it into every routine.

## Retired historical archive

The November 2026 dependency-hardening change removed the 23 files formerly
under `docs/archive/`. Each was already marked as superseded, had no runtime or
test consumer, and remains available in Git history. Live documentation
citations now point to the maintained ADR, validation, or runbook that carries
the binding decision or reconciled finding. The reviewed removal map is:

| Removed files | Reason and maintained replacement |
|---|---|
| `2026-08-07-baseline/{battle-test-critique,host-plane-evidence,identity-plane-evidence,repository-assessment,summary,task-authority-audit}.md` | Point-in-time assessment output; current behavior is maintained by the validation strategy, coverage document and executable gates. |
| `brief-implementation-status.md` | One-shot status snapshot; current implementation status is the code plus ADR implementation lines. |
| `plans/plans/{2026-08-15-git-sealed-store,2026-08-16-tombs-pass-otp-update,2026-08-30-infisical-cert-manager-parity-swarm}.md` | Completed planning notes; ADRs 0037, 0038 and 0066–0072 record the binding decisions. |
| `plans/specs/{2026-08-15-git-sealed-store-design,2026-08-16-tombs-pass-otp-update-design,2026-08-22-file-attachment-storage-implementation}.md` | Superseded design drafts; ADRs 0037, 0038 and 0054 are canonical. |
| `prompts/{2026-08-22-security-program-agent-brief,one-shot-automation-prompt,one-shot-connector-auth-broker-prompt,one-shot-doppler-nats-prompt,one-shot-doppler-parity-prompt,one-shot-passkey-portability-prompt,spa-multi-forge-vault-backup-prompt,vault-key-protection-age-sops-prompt}.md` | Agent assignment inputs, not product guidance; landed behavior and ADRs 0032, 0041, 0042 and 0129 are maintained. |
| `wallet-swarm-coordination.md` | Temporary coordination log; ADR 0123 owns the wallet spending decisions. |
| `README.md` | Index for only the retired files above; empty after their reviewed removal. |
