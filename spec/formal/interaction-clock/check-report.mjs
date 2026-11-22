import { readFileSync } from "node:fs";

const [reportPath] = process.argv.slice(2);
if (!reportPath)
  throw new Error("interaction-clock-formal: missing test report");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const suites = report.testResults ?? [];
const assertions = suites.flatMap((suite) => suite.assertionResults ?? []);
if (
  report.numTotalTests !== 1 ||
  report.numPassedTests !== 1 ||
  report.numFailedTests !== 0 ||
  suites.length !== 1 ||
  assertions.length !== 1 ||
  assertions[0].title !==
    "matches Lean's finite and invalid date boundary vectors" ||
  assertions[0].status !== "passed"
) {
  throw new Error(
    "interaction-clock-formal: expected correspondence test did not pass",
  );
}
