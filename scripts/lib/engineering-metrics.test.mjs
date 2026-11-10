import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aiLeverage,
  ciMetrics,
  deliveryMetrics,
  deploymentState,
  median,
  openPullRequestMetrics,
  parsePulse,
  percentile,
  pullRequestMetrics,
  pulseMetrics,
  securityMetrics,
} from "./engineering-metrics.mjs";
import { renderReport } from "./engineering-metrics-report.mjs";

const at = (day, hour = 0) =>
  new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const deploy = (environment, day, state, hour = 0) => ({
  environment,
  created_at: at(day, hour),
  state,
});

describe("percentiles", () => {
  it("interpolate, ignore non-numbers and report nothing for no data", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
    expect(median([Number.NaN, 4])).toBe(4);
    expect(median([])).toBeNull();
  });
});

describe("delivery", () => {
  it("reads a superseded success as a success, not as inactive", () => {
    expect(deploymentState(["SUCCESS", "INACTIVE"])).toBe("success");
    expect(deploymentState(["IN_PROGRESS", "FAILURE"])).toBe("failure");
    expect(deploymentState(["error"])).toBe("failure");
    expect(deploymentState(["QUEUED", "IN_PROGRESS"])).toBe("other");
  });

  it("derives frequency, failure rate and recovery per environment", () => {
    const metrics = deliveryMetrics(
      [
        deploy("Production", 1, "success"),
        deploy("Production", 2, "failure"),
        deploy("Production", 2, "success", 6),
        deploy("release", 3, "failure"),
        // A success elsewhere does not recover the release environment.
        deploy("Production", 4, "success"),
        deploy("release", 5, "other"),
      ],
      28,
    );
    expect(metrics).toEqual({
      deployments: 5,
      succeeded: 3,
      failed: 2,
      changeFailureRatePercent: 40,
      deploymentsPerWeek: 0.8,
      byEnvironment: { Production: 3, release: 0 },
      recoveryHoursMedian: 6,
      unrecoveredFailures: 1,
    });
  });

  it("reports no rate when nothing was deployed", () => {
    const metrics = deliveryMetrics([], 28);
    expect(metrics.changeFailureRatePercent).toBeNull();
    expect(metrics.recoveryHoursMedian).toBeNull();
    expect(metrics.deploymentsPerWeek).toBe(0);
  });
});

const pull = (number, title, login, created, merged, type = "User") => ({
  number,
  title,
  user: { login, type },
  created_at: created,
  merged_at: merged,
});

describe("pull requests", () => {
  const merged = [
    pull(1, "feat(pages): a", "ada", at(1), at(1, 4)),
    pull(2, "fix(ci): b", "ada", at(2), at(2, 2)),
    pull(3, 'Revert "feat(pages): a"', "lin", at(3), at(3, 12)),
    pull(4, "build(deps): bump x", "dependabot[bot]", at(4), at(4, 1), "Bot"),
  ];

  it("measures lead time, throughput per human and change shape", () => {
    const metrics = pullRequestMetrics(merged, [
      deploy("Production", 1, "success", 10),
      deploy("Production", 2, "failure", 3),
    ]);
    expect(metrics).toEqual({
      merged: 4,
      mergedByBots: 1,
      developers: 2,
      mergedPerDeveloper: 1.5,
      leadTimeToMainHoursMedian: 3,
      // Only pull request 1 was followed by a successful deployment.
      leadTimeToProductionHoursMedian: 6,
      leadTimeToProductionSample: 1,
      revertRatePercent: 25,
      featureSharePercent: 33.3,
      typedTitles: 3,
    });
  });

  it("flags only ready pull requests past the review expectation", () => {
    const open = [
      { number: 7, draft: false, created_at: at(1) },
      { number: 8, draft: true, created_at: at(1) },
      { number: 9, draft: false, created_at: at(9) },
    ];
    expect(openPullRequestMetrics(open, at(10), 3)).toEqual({
      open: 2,
      medianAgeDays: 5,
      stale: [{ number: 7, ageDays: 9 }],
    });
  });
});

describe("continuous integration", () => {
  it("separates first-attempt success from rerun-to-green noise", () => {
    const run = (id, attempt, conclusion, minutes) => ({
      id,
      run_attempt: attempt,
      conclusion,
      created_at: at(1),
      run_started_at: at(1),
      updated_at: new Date(Date.parse(at(1)) + minutes * 60_000).toISOString(),
    });
    const runs = [
      run(1, 1, "success", 10),
      run(2, 1, "failure", 20),
      run(3, 2, "success", 30),
      run(4, 1, "cancelled", 1),
    ];
    const jobs = {
      1: [
        { created_at: at(1), started_at: at(1), completed_at: at(1, 1) },
        {
          created_at: at(1),
          started_at: new Date(Date.parse(at(1)) + 30_000).toISOString(),
          completed_at: at(1, 2),
        },
      ],
    };
    expect(ciMetrics(runs, jobs)).toEqual({
      runs: 3,
      durationMinutesP50: 20,
      durationMinutesP95: 29,
      firstAttemptSuccessPercent: 33.3,
      flakeRatePercent: 33.3,
      queueSecondsP50: 15,
      queueSecondsP95: 28.5,
      firstFeedbackMinutesP50: 60,
      sampledRuns: 1,
    });
  });
});

describe("AI leverage", () => {
  const commit = (email, message) => ({
    commit: { author: { name: "n", email }, message },
  });

  it("counts agent authorship and agent co-author trailers", () => {
    const owner = "Tyler-R-Kendrick@users.noreply.github.com";
    const leverage = aiLeverage([
      commit("noreply@anthropic.com", "fix: a"),
      commit(
        owner,
        "feat: b\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ),
      commit(owner, "docs: c"),
      commit("someone@example.com", "chore: d"),
    ]);
    expect(leverage).toEqual({
      commits: 4,
      assisted: 2,
      percent: 50,
      byAgent: { claude: 2 },
    });
  });
});

describe("code security", () => {
  it("groups open alerts by severity and ages them", () => {
    const alerts = [
      { created_at: at(1), rule: { security_severity_level: "high" } },
      { created_at: at(5), rule: { security_severity_level: "high" } },
      { created_at: at(9), rule: { severity: "warning" } },
    ];
    expect(securityMetrics(alerts, at(11))).toEqual({
      open: 3,
      bySeverity: { high: 2, warning: 1 },
      medianOpenAgeDays: 6,
    });
  });
});

describe("engineering pulse", () => {
  const body = (flow, tooling, assistant) =>
    `### Flow state\n\n${flow}\n\n### Engineering tooling satisfaction\n\n${tooling}\n\n### AI assistant satisfaction\n\n${assistant}\n\n### Biggest friction\n\n5 hours waiting\n`;

  it("reads the scales and treats Not used as unanswered", () => {
    expect(
      parsePulse(body("4 - Usually", "2 - Dissatisfied", "Not used")),
    ).toEqual({ flow: 4, tooling: 2 });
    expect(parsePulse("unrelated text")).toEqual({});
  });

  it("takes the median of each scale and ignores unparseable issues", () => {
    const issues = [
      { body: body("4 - Usually", "2 - Dissatisfied", "Not used") },
      { body: body("2 - Rarely", "4 - Satisfied", "5 - Very satisfied") },
      { body: null },
    ];
    expect(pulseMetrics(issues)).toEqual({
      responses: 2,
      flowMedian: 3,
      toolingMedian: 3,
      assistantMedian: 5,
    });
  });

  it("parses the headings the issue form actually declares", () => {
    const form = readFileSync(
      new URL(
        "../../.github/ISSUE_TEMPLATE/engineering-pulse.yml",
        import.meta.url,
      ),
      "utf8",
    );
    for (const label of [
      "Flow state",
      "Engineering tooling satisfaction",
      "AI assistant satisfaction",
    ])
      expect(form).toContain(`label: ${label}\n`);
    expect(form).toContain('labels: ["engineering-pulse"]');
  });
});

describe("report", () => {
  const report = {
    window: { since: at(1), until: at(29), days: 28 },
    productionEnvironments: ["Production"],
    staleDays: 3,
    delivery: deliveryMetrics([deploy("Production", 2, "success")], 28),
    pulls: { unavailable: "HTTP 403" },
    open: { open: 1, medianAgeDays: 9, stale: [{ number: 7, ageDays: 9 }] },
    ci: ciMetrics([], {}),
    leverage: aiLeverage([]),
    security: { unavailable: "HTTP 404" },
    maintainability: { files: 2, violations: 3, oversizedLines: 40 },
    pulse: pulseMetrics([]),
    business: {
      engineeringExpensesToRevenuePercent: null,
      featureEngineeringExpensesPercent: null,
    },
  };

  it("names all twelve primary metrics and marks what could not be read", () => {
    const markdown = renderReport(report);
    for (const metric of [
      "Change failure rate",
      "Failed deployment recovery time (median)",
      "Code security",
      "Code maintainability",
      "Lead time to main (median)",
      "Deployment frequency",
      "PRs merged per developer (mean)",
      "Flow state experience (median)",
      "Engineering tooling satisfaction (median)",
      "AI assistant satisfaction (median)",
      "AI leverage",
      "Engineering expenses to revenue",
      "Feature engineering expenses to total",
    ])
      expect(markdown).toContain(metric);
    expect(markdown).toContain("unavailable (HTTP 403)");
    expect(markdown).toContain("unavailable (HTTP 404)");
    expect(markdown).toContain("not recorded");
    expect(markdown).toContain("no data");
    expect(markdown).toContain("Waiting past 3 days: #7 (9 d).");
  });
});
