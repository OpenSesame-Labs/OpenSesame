// Renders the engineering system metrics report as Markdown for a job summary.
// Only numbers and fixed labels are printed: no pull request title, branch
// name or other contributor-written text reaches the output.

function show(value, unit = "") {
  if (value === null || value === undefined) return "no data";
  return `${value}${unit}`;
}

function unavailable(section) {
  return section?.unavailable ? `unavailable (${section.unavailable})` : null;
}

function counts(map) {
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) return "none";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

function table(rows) {
  return [
    "| Metric | Kind | Value | Basis |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function qualityRows({ delivery, security, maintainability }) {
  const down = unavailable(delivery);
  const alerts = unavailable(security);
  return [
    [
      "Change failure rate",
      "lagging",
      down ?? show(delivery.changeFailureRatePercent, "%"),
      down
        ? ""
        : `${delivery.failed} failed of ${delivery.deployments} production deployments`,
    ],
    [
      "Failed deployment recovery time (median)",
      "lagging",
      down ?? show(delivery.recoveryHoursMedian, " h"),
      down
        ? ""
        : `${delivery.unrecoveredFailures} failure(s) not yet recovered`,
    ],
    [
      "Code security (open code scanning alerts)",
      "leading",
      alerts ?? show(security.open),
      alerts
        ? ""
        : `${counts(security.bySeverity)}; median age ${show(security.medianOpenAgeDays, " d")}`,
    ],
    [
      "Code maintainability (structural debt ledger)",
      "leading",
      show(maintainability.violations),
      `${show(maintainability.files)} files over budget, ${show(maintainability.oversizedLines)} oversized lines`,
    ],
  ];
}

function velocityRows({ delivery, pulls }) {
  const down = unavailable(delivery);
  const merged = unavailable(pulls);
  return [
    [
      "Lead time to main (median)",
      "lagging",
      merged ?? show(pulls.leadTimeToMainHoursMedian, " h"),
      merged ? "" : `${pulls.merged} merged pull requests, opened to merged`,
    ],
    [
      "Lead time to production (median)",
      "lagging",
      merged ?? show(pulls.leadTimeToProductionHoursMedian, " h"),
      merged
        ? ""
        : `${pulls.leadTimeToProductionSample} merged pull requests followed by a production deployment`,
    ],
    [
      "Deployment frequency",
      "lagging",
      down ?? show(delivery.deploymentsPerWeek, " / week"),
      down ? "" : counts(delivery.byEnvironment),
    ],
    [
      "PRs merged per developer (mean)",
      "lagging",
      merged ?? show(pulls.mergedPerDeveloper),
      merged
        ? ""
        : `${pulls.developers} developer(s); ${pulls.mergedByBots} more merged by bots`,
    ],
  ];
}

function happinessRows({ pulse }) {
  const down = unavailable(pulse);
  const basis = down
    ? ""
    : `${pulse.responses} pulse response(s), scale 1 to 5`;
  return [
    [
      "Flow state experience (median)",
      "leading",
      down ?? show(pulse.flowMedian),
      basis,
    ],
    [
      "Engineering tooling satisfaction (median)",
      "leading",
      down ?? show(pulse.toolingMedian),
      basis,
    ],
    [
      "AI assistant satisfaction (median)",
      "leading",
      down ?? show(pulse.assistantMedian),
      basis,
    ],
  ];
}

function businessRows({ leverage, pulls, business }) {
  const down = unavailable(leverage);
  const merged = unavailable(pulls);
  const recorded = (value) =>
    value === null || value === undefined ? "not recorded" : `${value}%`;
  return [
    [
      "AI leverage",
      "leading",
      down ?? show(leverage.percent, "%"),
      down
        ? ""
        : `${leverage.assisted} of ${leverage.commits} default-branch commits; ${counts(leverage.byAgent)}`,
    ],
    [
      "Engineering expenses to revenue",
      "lagging",
      recorded(business.engineeringExpensesToRevenuePercent),
      "owner-supplied; not derivable from the repository",
    ],
    [
      "Feature engineering expenses to total",
      "lagging",
      recorded(business.featureEngineeringExpensesPercent),
      merged
        ? "owner-supplied"
        : `owner-supplied; proxy: ${show(pulls.featureSharePercent, "%")} of ${pulls.typedTitles} typed merges are feat`,
    ],
  ];
}

function companionRows({ ci, pulls, open, staleDays }) {
  const down = unavailable(ci);
  const merged = unavailable(pulls);
  const waiting = unavailable(open);
  return [
    [
      "CI duration P50 / P95",
      "leading",
      down ??
        `${show(ci.durationMinutesP50)} / ${show(ci.durationMinutesP95, " min")}`,
      down ? "" : `${ci.runs} decided pull request runs`,
    ],
    [
      "CI first-attempt success rate",
      "leading",
      down ?? show(ci.firstAttemptSuccessPercent, "%"),
      "pairs with lead time",
    ],
    [
      "CI flake rate (rerun to green)",
      "leading",
      down ?? show(ci.flakeRatePercent, "%"),
      "noise rather than signal",
    ],
    [
      "CI queue time P50 / P95",
      "leading",
      down ?? `${show(ci.queueSecondsP50)} / ${show(ci.queueSecondsP95, " s")}`,
      down ? "" : `jobs of ${ci.sampledRuns} sampled runs`,
    ],
    [
      "CI time to first feedback (P50)",
      "leading",
      down ?? show(ci.firstFeedbackMinutesP50, " min"),
      "run created to first job finished",
    ],
    [
      "Revert rate",
      "lagging",
      merged ?? show(pulls.revertRatePercent, "%"),
      "pairs with change failure rate",
    ],
    [
      "Open pull requests past the review expectation",
      "leading",
      waiting ?? show(open.stale.length),
      waiting
        ? ""
        : `${open.open} open, median age ${show(open.medianAgeDays, " d")}; expectation ${staleDays} d`,
    ],
  ];
}

/** Markdown for the whole report. */
export function renderReport(report) {
  const stale = report.open?.stale ?? [];
  const lines = [
    "# Engineering system metrics",
    "",
    `Window: ${report.window.since.slice(0, 10)} to ${report.window.until.slice(0, 10)} (${report.window.days} days). Production means a deployment to: ${report.productionEnvironments.join(", ")}.`,
    "",
    "## Quality",
    "",
    table(qualityRows(report)),
    "",
    "## Velocity",
    "",
    table(velocityRows(report)),
    "",
    "## Developer happiness",
    "",
    table(happinessRows(report)),
    "",
    "## Business outcomes",
    "",
    table(businessRows(report)),
    "",
    "## Companion metrics",
    "",
    table(companionRows(report)),
    "",
  ];
  if (stale.length > 0) {
    const listed = stale
      .slice(0, 20)
      .map((entry) => `#${entry.number} (${entry.ageDays} d)`);
    lines.push(
      `Waiting past ${report.staleDays} days: ${listed.join(", ")}.`,
      "",
    );
  }
  lines.push(
    "Read the zones together. A number that improves while its companion gets worse is not an improvement. Definitions: docs/contributing/engineering-system-metrics.md.",
    "",
  );
  return lines.join("\n");
}
