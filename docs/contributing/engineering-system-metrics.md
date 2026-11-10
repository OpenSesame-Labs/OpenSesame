# Engineering system metrics

What is measured about how OpenSesame is built, where each number comes from, and how to read it. It follows GitHub's [Engineering System Metrics](https://learn.github.com/well-architected/productivity/recommendations/engineering-system-metrics): four zones, twelve primary metrics, each paired with a companion so that improving one number by damaging another shows.

The report runs every Monday in the [Engineering system metrics](../../.github/workflows/engineering-metrics.yml) workflow. It is the job summary of that run, plus a JSON artifact kept for 90 days. Nothing is committed and nothing gates a merge.

```bash
GH_TOKEN=<a read-only token> GITHUB_REPOSITORY=OpenSesame-Labs/OpenSesame \
  npm run metrics:engineering -- --days 28 --out metrics.json
```

## Definitions

The definitions are data, in [`tools/metrics/engineering-system.json`](../../tools/metrics/engineering-system.json). Changing a value there changes what a metric means, so say why in the pull request.

- **Window:** the last 28 days.
- **In production:** a GitHub deployment to the `Production`, `github-pages` or `release` environment. `Preview` is not production.
- **Production failure:** a production deployment whose status history contains `failure` or `error` and never `success`. A deployment later marked inactive because a newer one replaced it still counts as the success it was.
- **Review expectation:** a ready pull request is acted on within 3 days.

## The twelve metrics

"Leading" numbers move first and can be steered. "Lagging" numbers confirm the result afterwards.

### Quality

| Metric | Kind | How it is computed | Read it with |
|---|---|---|---|
| Change failure rate | Lagging | Failed production deployments ÷ production deployments that reached a result | Lead time, revert rate |
| Failed deployment recovery time (median) | Lagging | From a failed production deployment to the next successful one in the same environment. Failures not yet recovered are counted beside it | Deployment frequency |
| Code security and maintainability | Leading | Security: open code scanning alerts by severity and their median age. Maintainability: the structural debt ledger totals from [`quality-baseline.json`](../../tools/quality/quality-baseline.json), which may only fall ([ADR 0093](../adr/0093-structural-quality-gates.md)) | PRs merged per developer |

### Velocity

| Metric | Kind | How it is computed | Read it with |
|---|---|---|---|
| Lead time (median) | Lagging | To main: pull request opened to merged. To production: merged to the first successful production deployment after it | Change failure rate |
| Deployment frequency | Lagging | Successful production deployments per week, by environment | Change failure rate |
| PRs merged per developer (mean) | Lagging | Merged pull requests by people ÷ distinct people. Bot merges are shown separately | Code maintainability |

### Developer happiness

Filed through the [engineering pulse](../../.github/ISSUE_TEMPLATE/engineering-pulse.yml) issue form, each on a 1 to 5 scale. The report takes the median of the pulses opened in the window.

| Metric | Kind | Question |
|---|---|---|
| Flow state experience (median) | Leading | How often could you work without the engineering system interrupting you? |
| Engineering tooling satisfaction (median) | Leading | Local setup, hooks, CI, review and release, taken together |
| AI assistant satisfaction (median) | Leading | Coding agents and assistants used on this repository. Stands in for the framework's Copilot satisfaction, because more than one assistant is used here |

### Business outcomes

| Metric | Kind | How it is computed |
|---|---|---|
| AI leverage (%) | Leading | Default-branch commits carrying a recognised agent attribution ÷ all default-branch commits, using the same rules as the [attribution check](../../scripts/lib/agent-commit-attribution.mjs) |
| Engineering expenses to revenue (%) | Lagging | Owner-supplied in the definitions file. Not derivable from a repository; shown as "not recorded" until set |
| Feature engineering expenses to total (%) | Lagging | Owner-supplied. The report shows a proxy beside it: the share of conventionally typed merges whose type is `feat` |

## Companion metrics

These explain the primary numbers and come from [effective CI](github-well-architected.md#effective-ci).

| Metric | What it tells you | Warning sign |
|---|---|---|
| CI duration P50 / P95 | How long a pull request waits for the build | Steady increase |
| CI first-attempt success rate | How often a push passes first time | Sustained decline |
| CI flake rate | Runs that passed only after a rerun: noise, not signal | Any sustained rise |
| CI queue time P50 / P95 | Whether there is enough runner capacity | Sustained growth |
| CI time to first feedback | How soon the first job reports | Growth past a few minutes |
| Revert rate | Merges that undo an earlier merge | Rising with a falling lead time |
| Open pull requests past the review expectation | Feedback that is not arriving | Any, for more than a week |

CI numbers describe pull-request runs of `ci.yml`. Duration, success and flake rates use up to the 500 most recent completed runs in the window; queue time and first feedback use the jobs of the 20 most recent.

## Reading the report

- **Read zones together.** A shorter lead time with a higher change failure rate is not faster delivery.
- **"No data" is a result.** No production deployment in the window means no failure rate, not a perfect one.
- **"Unavailable" names the cause.** A section the token could not read shows the HTTP status. On a fork's pull request the code scanning section is unavailable by design.
- **Small samples mislead.** One maintainer makes "per developer" a count, and one pulse makes a median an opinion. The basis column shows the sample.
- **These are not targets for people.** A number that becomes a target stops measuring. PRs merged per developer in particular is easy to inflate by splitting work; it is shown beside maintainability for that reason.

## Stale pull requests

The report lists ready pull requests older than the review expectation and raises a workflow warning. The maintainer reads the Monday report; a pull request on that list is reviewed, closed with a reason, or converted to a draft that week.

## What is not measured

- Individual output. No lines of code, no commit counts per person.
- The two financial ratios, until the owner supplies them.
- Incidents in the running product. There is no hosted production service whose incidents live in this repository; a failed deployment is the recovery signal available here.

## Checklist from the recommendation

| Question | Answer |
|---|---|
| Balanced across people, process and technology? | Pulse (people), lead time and review flow (process), CI and code health (technology) |
| Tailored to this project? | Production, failure and the review expectation are defined above; Copilot satisfaction became assistant satisfaction |
| Balanced between leading and lagging? | Each table marks the kind; every zone but velocity has a leading metric, and CI companions lead velocity |
| Both qualitative and quantitative? | The pulse is qualitative; the rest is telemetry |
| Reliable and consistent collection? | One script, one definitions file, weekly, tested against fixtures in [`engineering-metrics.test.mjs`](../../scripts/lib/engineering-metrics.test.mjs) |
| Considered for gaming? | See "Reading the report"; no metric is tied to a person |
