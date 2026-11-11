#!/usr/bin/env node
// Requires a complete SARIF report and prints a short Markdown summary of it.
//
//   node scripts/security/sarif-summary.mjs <report.sarif>
//
// A scanner step that is allowed to exit non-zero when it finds advisories
// must not also be allowed to produce nothing. This exits non-zero when the
// report is missing, unreadable or not a SARIF 2.1.0 log with at least one
// run, so "the scanner did not run" can never read as "nothing was found".
// Only counts and advisory identifiers are printed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LISTED = 25;

/** The results of one run, refusing a run that names no tool or has none. */
function runResults(run) {
  if (!run?.tool?.driver?.name) throw new Error("a run names no tool");
  if (!Array.isArray(run.results))
    throw new Error("a run carries no results array");
  return run.results;
}

/** Counts of findings per advisory in a parsed SARIF log. */
export function summarize(log) {
  const runs = log?.runs;
  if (log?.version !== "2.1.0" || !Array.isArray(runs) || runs.length === 0)
    throw new Error("not a SARIF 2.1.0 log with at least one run");
  const byRule = new Map();
  let findings = 0;
  for (const run of runs) {
    for (const result of runResults(run)) {
      findings += 1;
      const rule = String(result?.ruleId ?? "unidentified");
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }
  }
  const advisories = [...byRule.entries()].sort(
    ([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1),
  );
  return {
    tools: runs.map((run) => run.tool.driver.name),
    findings,
    advisories,
  };
}

/** Markdown for a job summary. Advisory identifiers are public names. */
export function render({ tools, findings, advisories }) {
  const lines = [
    `Scanner: ${[...new Set(tools)].join(", ")}. ${findings} finding(s) across ${advisories.length} advisory identifier(s).`,
    "",
  ];
  if (advisories.length > 0) {
    lines.push("| Advisory | Findings |", "|---|---|");
    for (const [rule, count] of advisories.slice(0, MAX_LISTED))
      lines.push(`| ${rule.replaceAll("|", " ")} | ${count} |`);
    if (advisories.length > MAX_LISTED)
      lines.push(`| … and ${advisories.length - MAX_LISTED} more | |`);
    lines.push("");
  }
  return lines.join("\n");
}

function main(path) {
  if (!path) {
    console.error("usage: sarif-summary.mjs REPORT.sarif");
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`No report at ${path}: the scanner did not produce one.`);
    process.exit(1);
  }
  try {
    console.log(render(summarize(JSON.parse(text))));
  } catch (error) {
    console.error(`Incomplete report at ${path}: ${error.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main(process.argv[2]);
