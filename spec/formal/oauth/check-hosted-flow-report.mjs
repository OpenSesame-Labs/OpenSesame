import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const testFile = resolve(
  root,
  "packages/control-plane/src/__tests__/federated-interaction.test.ts",
);
const suite = "federated leg, organization sign-in";
const required = [
  "admits the subject and joins it to the tenant",
  "refuses an in-flight sign-in if the issuer changes organizations",
];

function fail(message) {
  throw new Error(`oauth-formal: hosted-flow report ${message}`);
}

if (process.argv.length !== 3) fail("requires exactly one JSON report");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (
  report?.success !== true ||
  report?.numFailedTests !== 0 ||
  !Array.isArray(report?.testResults)
) {
  fail("does not describe a successful test run");
}
const files = report.testResults.filter((file) => file?.name === testFile);
if (
  files.length !== 1 ||
  files[0].status !== "passed" ||
  !Array.isArray(files[0].assertionResults)
) {
  fail("does not contain exactly one successful hosted-flow test file");
}
for (const title of required) {
  const matches = files[0].assertionResults.filter(
    (test) =>
      test?.title === title &&
      test?.fullName === `${suite} ${title}` &&
      Array.isArray(test?.ancestorTitles) &&
      test.ancestorTitles.length === 1 &&
      test.ancestorTitles[0] === suite,
  );
  if (matches.length !== 1 || matches[0].status !== "passed") {
    fail(`requires exactly one passing result for ${suite} / ${title}`);
  }
}
if (
  !Number.isSafeInteger(report.numPassedTests) ||
  report.numPassedTests < required.length
) {
  fail("does not report both required tests as passed");
}
console.log("oauth-formal: both required hosted-flow tests passed");
