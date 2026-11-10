// Keeps the SSDF and Well-Architected record honest: every practice is
// recorded, every status is one of the six defined words, and every piece of
// evidence it links to exists. See ADR 0222.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const pages = [
  "docs/adr/0222-github-well-architected-and-ssdf.md",
  "docs/security/ssdf-conformance.md",
  "docs/security/github-repository-threat-model.md",
  "docs/security/actions-security.md",
  "docs/security/dependency-supply-chain.md",
  "docs/security/developer-workspace.md",
  "docs/security/alert-triage.md",
  "docs/contributing/github-well-architected.md",
  "docs/contributing/engineering-system-metrics.md",
];
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** Repository-relative targets of the Markdown links in one page. */
function localLinks(page) {
  const targets = [];
  for (const match of read(page).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    targets.push(new URL(target, new URL(page, root)));
  }
  return targets;
}

describe("the engineering system record", () => {
  it.each(pages)("%s links only to files that exist", (page) => {
    const links = localLinks(page);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      expect(existsSync(link), link.pathname).toBe(true);
  });

  it("records every SSDF practice", () => {
    const text = read("docs/security/ssdf-conformance.md");
    const practices = [
      ...["1", "2", "3", "4", "5"].map((n) => `PO.${n}`),
      ...["1", "2", "3"].map((n) => `PS.${n}`),
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => `PW.${n}`),
      ...["1", "2", "3"].map((n) => `RV.${n}`),
    ];
    for (const practice of practices)
      expect(text, practice).toMatch(
        new RegExp(`\\b${practice.replace(".", "\\.")}\\b`),
      );
  });

  it("gives every SSDF practice row one of the defined states", () => {
    const states =
      /^(Enforced|Declared|Owner setting|Deviation|Gap|Not applicable)\b/;
    const rows = read("docs/security/ssdf-conformance.md")
      .split("\n")
      .filter((line) => /^\| (PO|PS|PW|RV)\.\d /.test(line));
    expect(rows).toHaveLength(19);
    for (const row of rows)
      expect(row.split("|")[2].trim(), row).toMatch(states);
  });

  it("records every threat and actor of the repository threat model", () => {
    const text = read("docs/security/github-repository-threat-model.md");
    for (let n = 1; n <= 8; n += 1) expect(text).toContain(`T-0${n}`);
    for (let n = 1; n <= 9; n += 1) expect(text).toContain(`TA-0${n}`);
  });

  it("defines all twelve engineering system metrics", () => {
    const text = read("docs/contributing/engineering-system-metrics.md");
    for (const metric of [
      "Change failure rate",
      "Failed deployment recovery time",
      "Code security and maintainability",
      "Lead time",
      "Deployment frequency",
      "PRs merged per developer",
      "Flow state experience",
      "Engineering tooling satisfaction",
      "AI assistant satisfaction",
      "AI leverage",
      "Engineering expenses to revenue",
      "Feature engineering expenses to total",
    ])
      expect(text).toContain(metric);
  });

  it("names every adopted recommendation in the hub page", () => {
    const text = read("docs/contributing/github-well-architected.md");
    for (const path of [
      "scenarios/nist-ssdf-implementation",
      "scenarios/anti-patterns",
      "productivity/design-principles",
      "productivity/recommendations/effective-ci",
      "productivity/recommendations/engineering-system-metrics",
      "application-security/checklist",
      "application-security/recommendations/securing-developer-workspace",
      "application-security/recommendations/managing-dependency-threats",
      "application-security/recommendations/prioritizing-alerts",
      "application-security/recommendations/actions-security",
      "application-security/recommendations/threat-model",
      "governance/checklist",
    ])
      expect(text).toContain(
        `https://learn.github.com/well-architected/${path}`,
      );
  });

  it("keeps the fourteen anti-patterns answered", () => {
    const text = read("docs/contributing/github-well-architected.md");
    const section = text.split("## Anti-patterns")[1].split("\n## ")[0];
    const rows = section.split("\n").filter((line) => /^\| [A-Z]/.test(line));
    expect(
      rows.filter((row) => !row.startsWith("| Anti-pattern")),
    ).toHaveLength(14);
  });
});
