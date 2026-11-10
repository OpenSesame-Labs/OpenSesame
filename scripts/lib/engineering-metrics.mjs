// Pure computations behind the engineering system metrics report.
// Inputs are plain GitHub API objects; nothing here touches the network.
// Definitions: docs/contributing/engineering-system-metrics.md
import { recognizedAgentId } from "./agent-commit-attribution.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function round(value, digits = 1) {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Linear-interpolated percentile; null when there is nothing to measure. */
export function percentile(values, rank) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = ((sorted.length - 1) * rank) / 100;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export const median = (values) => percentile(values, 50);

function percent(part, whole) {
  return whole === 0 ? null : round((100 * part) / whole);
}

const elapsed = (from, to) => Date.parse(to) - Date.parse(from);

/**
 * One state for a deployment from its status history. GitHub marks an older
 * deployment `inactive` when a newer one succeeds, so the latest status alone
 * would hide that the older one had succeeded.
 */
export function deploymentState(states) {
  const seen = states.map((state) => String(state).toLowerCase());
  if (seen.includes("success")) return "success";
  if (seen.includes("failure") || seen.includes("error")) return "failure";
  return "other";
}

function recoveryHours(ordered) {
  const hours = [];
  let unrecovered = 0;
  for (const [index, deployment] of ordered.entries()) {
    if (deployment.state !== "failure") continue;
    const next = ordered
      .slice(index + 1)
      .find((later) => later.state === "success");
    if (next)
      hours.push(elapsed(deployment.created_at, next.created_at) / HOUR);
    else unrecovered += 1;
  }
  return { hours, unrecovered };
}

/** Deployment frequency, change failure rate and failed-deployment recovery. */
export function deliveryMetrics(deployments, windowDays) {
  const terminal = deployments.filter((entry) => entry.state !== "other");
  const succeeded = terminal.filter((entry) => entry.state === "success");
  const byEnvironment = {};
  const hours = [];
  let unrecovered = 0;
  for (const environment of new Set(terminal.map((e) => e.environment))) {
    const ordered = terminal
      .filter((entry) => entry.environment === environment)
      .sort((a, b) => elapsed(b.created_at, a.created_at));
    byEnvironment[environment] = ordered.filter(
      (entry) => entry.state === "success",
    ).length;
    const recovery = recoveryHours(ordered);
    hours.push(...recovery.hours);
    unrecovered += recovery.unrecovered;
  }
  return {
    deployments: terminal.length,
    succeeded: succeeded.length,
    failed: terminal.length - succeeded.length,
    changeFailureRatePercent: percent(
      terminal.length - succeeded.length,
      terminal.length,
    ),
    deploymentsPerWeek: round((succeeded.length * 7) / windowDays),
    byEnvironment,
    recoveryHoursMedian: round(median(hours)),
    unrecoveredFailures: unrecovered,
  };
}

const CONVENTIONAL = /^(\w+)(\([^)]*\))?!?:\s/;

function leadToProduction(pull, successes) {
  const next = successes.find(
    (entry) => elapsed(pull.merged_at, entry.created_at) >= 0,
  );
  return next ? elapsed(pull.merged_at, next.created_at) / HOUR : null;
}

/** Lead time, merge throughput and the companion change-shape signals. */
export function pullRequestMetrics(merged, deployments) {
  const humans = merged.filter((pull) => pull.user?.type !== "Bot");
  const authors = new Set(humans.map((pull) => pull.user?.login));
  const successes = deployments
    .filter((entry) => entry.state === "success")
    .sort((a, b) => elapsed(b.created_at, a.created_at));
  const toProduction = merged
    .map((pull) => leadToProduction(pull, successes))
    .filter((hours) => hours !== null);
  const typed = merged
    .map((pull) => CONVENTIONAL.exec(pull.title ?? "")?.[1]?.toLowerCase())
    .filter(Boolean);
  return {
    merged: merged.length,
    mergedByBots: merged.length - humans.length,
    developers: authors.size,
    mergedPerDeveloper:
      authors.size === 0 ? null : round(humans.length / authors.size),
    leadTimeToMainHoursMedian: round(
      median(merged.map((p) => elapsed(p.created_at, p.merged_at) / HOUR)),
    ),
    leadTimeToProductionHoursMedian: round(median(toProduction)),
    leadTimeToProductionSample: toProduction.length,
    revertRatePercent: percent(
      merged.filter((pull) => /^revert\b/i.test(pull.title ?? "")).length,
      merged.length,
    ),
    featureSharePercent: percent(
      typed.filter((type) => type === "feat").length,
      typed.length,
    ),
    typedTitles: typed.length,
  };
}

/** Open, non-draft pull requests and the ones past the review expectation. */
export function openPullRequestMetrics(open, now, staleDays) {
  const ready = open.filter((pull) => !pull.draft);
  const ages = ready.map((pull) => ({
    number: pull.number,
    ageDays: round(elapsed(pull.created_at, now) / DAY),
  }));
  return {
    open: ready.length,
    medianAgeDays: round(median(ages.map((entry) => entry.ageDays))),
    stale: ages
      .filter((entry) => entry.ageDays > staleDays)
      .sort((a, b) => b.ageDays - a.ageDays),
  };
}

function jobTimings(run, jobs) {
  const started = jobs.filter((job) => job.started_at && job.created_at);
  const finished = jobs
    .filter((job) => job.completed_at)
    .map((job) => Date.parse(job.completed_at));
  return {
    queueSeconds: started.map(
      (job) => Math.max(0, elapsed(job.created_at, job.started_at)) / 1000,
    ),
    firstFeedbackMinutes:
      finished.length === 0
        ? null
        : (Math.min(...finished) - Date.parse(run.created_at)) / 60_000,
  };
}

/** CI feedback speed and trust: duration, flake rate, queue, first attempt. */
export function ciMetrics(runs, jobsByRun) {
  const decided = runs.filter((run) =>
    ["success", "failure"].includes(run.conclusion),
  );
  const minutes = decided.map(
    (run) =>
      elapsed(run.run_started_at ?? run.created_at, run.updated_at) / 60_000,
  );
  const queue = [];
  const feedback = [];
  for (const run of runs) {
    const jobs = jobsByRun[run.id];
    if (!jobs) continue;
    const timings = jobTimings(run, jobs);
    queue.push(...timings.queueSeconds);
    if (timings.firstFeedbackMinutes !== null)
      feedback.push(timings.firstFeedbackMinutes);
  }
  return {
    runs: decided.length,
    durationMinutesP50: round(percentile(minutes, 50)),
    durationMinutesP95: round(percentile(minutes, 95)),
    firstAttemptSuccessPercent: percent(
      decided.filter((r) => r.run_attempt === 1 && r.conclusion === "success")
        .length,
      decided.length,
    ),
    flakeRatePercent: percent(
      decided.filter((r) => r.run_attempt > 1 && r.conclusion === "success")
        .length,
      decided.length,
    ),
    queueSecondsP50: round(percentile(queue, 50)),
    queueSecondsP95: round(percentile(queue, 95)),
    firstFeedbackMinutesP50: round(percentile(feedback, 50)),
    sampledRuns: Object.keys(jobsByRun).length,
  };
}

function assistingAgent(entry) {
  const byAuthor = recognizedAgentId(entry);
  if (byAuthor && byAuthor !== "tyler") return byAuthor;
  const byTrailer = recognizedAgentId({
    commit: { author: {}, message: entry.commit?.message ?? "" },
  });
  return byTrailer && byTrailer !== "tyler" ? byTrailer : undefined;
}

/** Share of default-branch commits that carry an agent attribution. */
export function aiLeverage(commits) {
  const byAgent = {};
  for (const entry of commits) {
    const agent = assistingAgent(entry);
    if (agent) byAgent[agent] = (byAgent[agent] ?? 0) + 1;
  }
  const assisted = Object.values(byAgent).reduce((sum, n) => sum + n, 0);
  return {
    commits: commits.length,
    assisted,
    percent: percent(assisted, commits.length),
    byAgent,
  };
}

function alertSeverity(alert) {
  return (
    alert.rule?.security_severity_level ?? alert.rule?.severity ?? "unknown"
  );
}

/** Open code scanning alerts by severity and how long they have been open. */
export function securityMetrics(alerts, now) {
  const bySeverity = {};
  for (const alert of alerts) {
    const severity = alertSeverity(alert);
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }
  return {
    open: alerts.length,
    bySeverity,
    medianOpenAgeDays: round(
      median(alerts.map((alert) => elapsed(alert.created_at, now) / DAY)),
    ),
  };
}

const PULSE_FIELDS = {
  flow: "Flow state",
  tooling: "Engineering tooling satisfaction",
  assistant: "AI assistant satisfaction",
};

/** Scores from one engineering-pulse issue form body; absent means unanswered. */
export function parsePulse(body) {
  const scores = {};
  for (const [key, heading] of Object.entries(PULSE_FIELDS)) {
    const answer = new RegExp(
      `^### ${heading}\\s*\\n+\\s*([1-5])\\b`,
      "m",
    ).exec(String(body ?? ""));
    if (answer) scores[key] = Number(answer[1]);
  }
  return scores;
}

/** Median of each pulse scale across the responses filed in the window. */
export function pulseMetrics(issues) {
  const responses = issues.map((issue) => parsePulse(issue.body));
  const scale = (key) =>
    round(median(responses.map((r) => r[key]).filter((v) => v !== undefined)));
  return {
    responses: responses.filter((r) => Object.keys(r).length > 0).length,
    flowMedian: scale("flow"),
    toolingMedian: scale("tooling"),
    assistantMedian: scale("assistant"),
  };
}
