import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// No advisory is excepted. The former Glob and Minimatch backport tuples were
// removed when every consumer moved to published releases outside the
// advisory ranges, so any finding, in either report format, fails the gate.

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizedCveLiteFindings(report, root) {
  if (
    !report ||
    !Array.isArray(report.findings) ||
    report.findingCount !== report.findings.length
  )
    fail("invalid cve-lite findings");
  return report.findings.flatMap((finding) => {
    if (!finding || !Array.isArray(finding.vulnerabilities))
      fail("invalid cve-lite finding");
    return finding.vulnerabilities.map((vulnerability) => ({
      id: vulnerability?.id,
      ecosystem: "npm",
      package: finding.package,
      version: finding.version,
      source: join(root, "package-lock.json"),
    }));
  });
}

export function attestRepairedFindings(root, findings) {
  realpathSync(root);
  if (!Array.isArray(findings)) fail("Expected a findings array");
  if (findings.length === 0) return { count: 0, tuples: [] };
  const [finding] = findings;
  fail(
    `unattested advisory tuple: ${finding?.id ?? "?"} ${finding?.package ?? "?"}@${finding?.version ?? "?"} from ${finding?.source ?? "?"}`,
  );
}

export function main(argv) {
  try {
    if (argv.length !== 1 && argv.length !== 3)
      fail(
        "Expected one findings file, optionally followed by --attest-repaired ROOT",
      );
    const report = readJson(argv[0]);
    if (argv.length === 1) {
      if (!Array.isArray(report)) fail("Expected a findings array");
      if (report.length !== 0)
        fail(`Reported vulnerabilities: ${JSON.stringify(report)}`);
      console.log("osv-scanner gate: CLEAN (no findings)");
      return 0;
    }
    if (argv[1] !== "--attest-repaired") fail("Unknown advisory gate mode");
    const root = realpathSync(argv[2]);
    const findings = Array.isArray(report)
      ? report
      : normalizedCveLiteFindings(report, root);
    attestRepairedFindings(root, findings);
    console.log("osv-scanner gate: CLEAN (no findings)");
    return 0;
  } catch (error) {
    console.error(`osv-scanner gate: FAIL (${error.message})`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
