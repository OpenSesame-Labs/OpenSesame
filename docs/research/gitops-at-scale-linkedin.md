# GitOps at scale: what LinkedIn learned leaving Argo CD

> Status (2026-11-13): research only. No ADR adopts it yet. §4 lists proposals,
> and none of them is built.

Source: InfoQ, "LinkedIn Replaces Argo CD with a Custom GitOps Engine for
Kubernetes Deployments" (Claudio Masolo, 2026-11-12,
<https://www.infoq.com/news/2026/11/kubernetes-argocd-linkedin/>). That article
summarizes LinkedIn's engineering post
(<https://www.linkedin.com/blog/engineering/infrastructure/how-we-scale-deployments-with-a-custom-gitops-engine>),
which we did not read for this note. Figures below are as InfoQ reports them.

OpenSesame does not run Kubernetes or Argo CD. No manifests are checked in, and
the one Kubernetes design, [ADR 0072](../adr/0072-kubernetes-external-issuer.md),
is not built. The lessons still apply, because this repository runs GitOps of
its own:

- **Settings as code.** `ops/github/*.json` declares rulesets, environments
  and security settings. `governance.mjs` and `security-settings.mjs` run
  `--dry-run`, `--apply` and `--verify` against the live repository
  ([ops/github](../../ops/github/README.md)).
- **A drift alarm.** The `repository-settings` job in
  `.github/workflows/security.yml` snapshots live settings and fails when they
  change (`scripts/security/settings-snapshot.mjs`).
- **Candidate promotion.** An immutable candidate moves through nightly, weekly
  and publication stages with receipts bound to it
  ([CI and artifact promotion](../operators/ci-promotion.md),
  [ADR 0214](../adr/0214-trunk-ci-artifact-promotion.md)).

## 1. What LinkedIn reported

**Scale.** More than 250 clusters of up to 5,000 nodes each, more than 4,000
services, and over 100,000 deployments a week.

**Starting point.** LinkedIn ran one Argo CD instance per cluster, behind a
central orchestrator that started an ephemeral pod for each deployment.
Upgrading 200+ instances took weeks each time.

**What broke at scale:**

1. Argo CD has no `observedGeneration`, so a "Synced/Healthy" status could not
   be tied to one deployment. A custom Lua health check with a tracking
   annotation worked around it.
2. A Synced and Healthy app could resolve to an unintended revision through
   stale repo-server cache entries.
3. Watch contention: Argo CD keeps one watch per group-version-resource across
   all apps, so churn from one app slowed syncs for every app. A sync took
   under 3 minutes at 60,000 pods and over 10 minutes past 80,000.
4. Server-side apply truncates `managedFields` after more than 10 distinct
   field managers. The API server then loses track of field ownership, so a
   container removed from the manifest could survive on the live Pod **with no
   error**.
5. Pruning was off, because destructive operations in production need approval.
6. CRD schema changes forced controller restarts across the fleet.
7. Some OutOfSync states did not reflect real drift.
8. Real errors were buried in boilerplate.

**The replacement** is an internal library, not a controller. Flux was rejected
because it uses the same shared-controller model. In the new design:

- Each deployment runs in its own pod, with no shared controller state.
- Updates use full-replacement `PUT`, not `PATCH`, and retry on
  `resourceVersion` conflicts with exponential backoff.
- Drift detection is a **3-way diff** across the live object, the manifest
  deployed last time, and the newly rendered manifest. Genuine drift fails the
  deployment.
- The same pod watches status until the objects converge or time out, and
  surfaces the API server's own error.
- Objects missing from the new render become **deletion candidates**, subject
  to delete protection.

Argo CD still manages cluster add-ons.

**Outcome.** Comparing the same month a year apart, deployment infrastructure
failures fell from 925 to 63 while volume grew 3.7×. Median time to detect and
conclude a failed deploy fell from 16.1 to 2.45 minutes. Mean and tail
durations improved, which LinkedIn credits to a namespace-scoped cache. The
article notes that orchestrator error handling improved over the same period,
and that drift errors are excluded from the counts, so not all of the gain is
the engine's.

**Peers mentioned.** Uber's Up platform uses a long-running controller per
deployment. Airbnb's deploy tool returns one atomic success or failure, and
counts a container that restarts in the first 30 seconds as a failed deploy.

## 2. The lessons, generalized

| # | Lesson | Why it matters beyond Kubernetes |
|---|---|---|
| L1 | Bind status to the exact change that was applied. | "Healthy" without an identity can't tell you which apply it describes. |
| L2 | Never resolve "latest" from a cache at apply time. | A stale read promotes the wrong revision while every check is green. |
| L3 | Isolate each deployment. Don't share a reconciler. | Shared watchers and queues make one noisy tenant everyone's latency. |
| L4 | Know who owns every live field, and notice when ownership is lost. | Something you removed from the declaration can live on in silence. |
| L5 | Deletion is a reviewed, first-class step, not a disabled feature. | With pruning off, live state grows past the declaration forever. |
| L6 | Diff three ways: live, last applied, desired. | A 2-way diff can't tell an intended change from out-of-band drift, so it either alarms on its own applies or misses tampering. |
| L7 | Report the API's real error. | Boilerplate hides why a deploy failed and slows detection. |
| L8 | Apply, then wait for convergence, with one atomic outcome. | "Submitted" is not "converged". Time to detect failure is the number that improved most. |
| L9 | Build only when your operating model diverges, and keep the mature tool where it fits. | LinkedIn kept Argo CD for add-ons. |

## 3. Where OpenSesame already stands

| Lesson | Status here | Evidence |
|---|---|---|
| L1 identity binding | **Strong** | Receipts bind the whole candidate envelope (`candidate_id`, `source_sha`, run/attempt, artifact and payload digests) and the policy digest. Served Pages content must match the qualified files. |
| L2 no cached "latest" | **Strong** | "Jobs never independently select whatever happens to be latest." A weekly rerun keeps its frozen selection, and a missing candidate fails visibly. |
| L3 isolation | **Mostly** | Each Actions job is an ephemeral runner, the same per-deployment-pod model LinkedIn moved to. One shared queue remains: the `cd-pwa` concurrency group (`cancel-in-progress: false`) delayed a run by about 3.5 minutes behind another. That is head-of-line blocking, accepted on purpose. |
| L4 ownership | **Gap** | `governance.mjs --apply` "preserves unrelated rulesets", and the snapshot's `declared` step only reports undeclared live rulesets ("informational, it never fails the run"). Nothing records that a ruleset *we* created is still ours once its file is removed. |
| L5 deletion | **Gap (partial)** | Pages branch policies are pruned to the default branch. Rulesets and environments are never pruned, and a declaration removed from `ops/github/` leaves its live object running. |
| L6 3-way diff | **Gap** | Apply/verify is 2-way (declared vs live). The alarm is 2-way in time (previous live vs current live), so it fails on every change, including an administrator's intended `--apply` ("one change fails one scheduled run"). That is LinkedIn's problem 7, false OutOfSync, in another form. |
| L7 real errors | **Mixed** | `security-settings.mjs` reports the HTTP status and lists each drifted setting. `governance.mjs` replaces every failure with one generic message (no status) and fails `--verify` without saying which check drifted. Both rightly keep response bodies out of logs. |
| L8 convergence | **Strong for releases, weak for settings** | Release: Pages is verified live, and npm waits for the published version (300 s deadline). Settings: `--apply` re-reads once and verifies. Detection runs **weekly** (cron `23 5 * * 1`), so a ruleset disabled on Monday afternoon goes unseen for about 7 days. LinkedIn's headline gain was cutting detection time. |
| L9 build vs adopt | **Consistent** | The governance scripts are small (about 200 lines each) and exist for semantics off-the-shelf tools don't promise: an HTTP 403 is never a success, and a checked-in proposal is never treated as live. |

## 4. Proposals

These are ordered by value per effort. None is built, and each would ship as
its own PR.

### P1. Three-way drift classification for repository settings (L6, L1)

Today the alarm compares the previous live record with the current live
record. Add a third input: the declaration at the commit the previous run used
and at the current commit. Then classify each changed setting:

| live changed? | declaration changed to match? | Class | Action |
|---|---|---|---|
| no | no | in sync | none |
| yes | yes | **intended apply** | record, summarize, don't fail |
| yes | no | **out-of-band drift** | fail (the alarm) |
| no | yes | **pending apply** | report "declared, not live" |
| yes | changed, but not to the live value | **conflict** | fail |

This removes the false alarm on our own applies without weakening the real
one. It needs no new permission: the job already reads the live settings and
checks out the repository. It applies only where a declaration exists (the
three named rulesets and the two environments). Undeclared settings keep
today's alarm-on-any-change behavior.

### P2. An ownership ledger, and deletion as a reviewed step (L4, L5)

Have `--apply` write a small `applied` record (ruleset names and IDs,
environment names, and the commit they came from) to the run artifact or
summary. Don't commit it to the repository, following the
[repository footprint](../contributing/repository-footprint.md) rules. On the
next run, any ID in the ledger whose declaration file is gone becomes a
**deletion candidate**:

- `--dry-run` lists it.
- `--apply` never deletes it.
- A separate `--prune` mode deletes it, behind the same owner approval as
  today's environment changes.

This matches LinkedIn's model, where an object is a deletion candidate and
delete protection decides. It also closes the silent-survivor gap the same way
the allowed-actions test already does for Actions (`a removed one leaves no
standing permission`).

### P3. Report real errors in `governance.mjs` (L7)

Two changes:

- Reuse the `--include` status parsing from `security-settings.mjs`, so a 403
  reads as a 403, not as "check repository administration permission".
- Have `--verify` print the names of the checks that failed (for example
  `ruleset:opensesame-release-tags`, `pages:remove`, `auto_merge`), never their
  values.

The fix is small and keeps the no-bodies-in-logs rule.

### P4. Faster detection (L8)

The settings alarm runs weekly. Two options:

- **Cheap:** give the `repository-settings` job its own daily schedule, split
  from the heavy weekly scanners. It is a 10-minute read-only job.
- **Event-driven:** add a separate workflow triggered by `on:
  branch_protection_rule`. This covers classic branch protection only; GitHub
  has no Actions trigger for rulesets, so the scheduled snapshot stays.

The baseline-trust rule in the alarm treats only scheduled runs as baselines.
Event-triggered runs must keep that rule: they compare, but are never a
baseline.

### P5. Prefer full replacement on writes (L4)

`governance.mjs` already writes rulesets with a full `PUT` of the declaration,
which is LinkedIn's choice. Keep it that way, and document it as a rule:
desired state is written whole, never patched field by field, so a field
dropped from the JSON is dropped live. The `PATCH` on `allow_auto_merge` is a
single scalar and is fine.

### P6. Requirements for a future Kubernetes surface (ADR 0072)

If `apps/k8s-issuer/deploy/` ever ships:

- Don't make per-cluster Argo CD a requirement. Ship plain manifests (or one
  Helm chart) that any engine can apply, Argo CD, Flux or a custom one.
- The issuer writes `CertificateRequest` status, and cert-manager writes the
  `Secret`. Use one field manager per writer, and never patch fields another
  manager owns. A long-lived `Secret` with many writers is exactly the shape
  where `managedFields` truncation (L4) bites.
- Report readiness through `status.observedGeneration` and conditions (L1),
  so any GitOps engine can bind health to a specific spec.
- Scope informers to the namespaces that hold `CertificateRequest`s addressed
  to this issuer, not cluster-wide (L3).

## 5. What we should not take from this

- **Writing our own engine.** LinkedIn's reason was 250 clusters and 100,000
  deployments a week. Ours is a single repository's settings and one release
  train. P1–P4 are changes to existing scripts, not a new controller.
- **Treating the 925 → 63 figure as the engine's alone.** The article says the
  orchestrator's error classification also improved in that period, and that
  drift errors are excluded from the counts.
- **Turning on auto-pruning.** LinkedIn kept delete protection, and so should
  we (P2).
