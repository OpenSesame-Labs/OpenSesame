import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originScoreTarget } from "./web-score-common.mjs";
import { inspectReport, runLighthouse } from "./web-score-lighthouse.mjs";

const targetUrl = new URL("https://example.test/OpenSesame/");
const startedAt = Date.now();
const options = {
  exitCode: 0,
  targetUrl,
  startedAt,
  formFactor: "mobile",
  expectApp: true,
};

it("does not attribute an origin score to an app path or query", () => {
  expect(originScoreTarget(new URL("https://example.test/"))).toBe(
    "https://example.test/",
  );
  expect(originScoreTarget(targetUrl)).toBeNull();
  expect(
    originScoreTarget(new URL("https://example.test/?view=app")),
  ).toBeNull();
});

function report(selector = "div.unlock > p.door__lede") {
  return {
    fetchTime: new Date(startedAt).toISOString(),
    finalUrl: targetUrl.href,
    configSettings: { formFactor: "mobile" },
    categories: Object.fromEntries(
      ["performance", "accessibility", "best-practices", "seo"].map((id) => [
        id,
        { score: 1, auditRefs: [{ id: `metric-${id}`, weight: 1 }] },
      ]),
    ),
    audits: {
      ...Object.fromEntries(
        ["performance", "accessibility", "best-practices", "seo"].map((id) => [
          `metric-${id}`,
          { scoreDisplayMode: "numeric" },
        ]),
      ),
      "largest-contentful-paint-element": {
        details: {
          items: [{ items: [{ node: { selector, snippet: "<p>" } }] }],
        },
      },
    },
  };
}

describe("Lighthouse report evidence", () => {
  it("accepts a fresh report for the real app on the requested form factor", () => {
    expect(inspectReport(report(), options).problems).toEqual([]);
  });

  it("rejects a placeholder or an unidentified largest paint", () => {
    expect(inspectReport(report("p.boot__status"), options).problems).toContain(
      "the largest paint was the startup placeholder, not the app",
    );
    const missing = report();
    missing.audits = {};
    expect(inspectReport(missing, options).problems).toContain(
      "could not identify the largest painted element",
    );
  });

  it("rejects incomplete runs and scored audits that errored", () => {
    const incomplete = report();
    incomplete.runWarnings = [
      "The page loaded too slowly; results may be incomplete.",
    ];
    incomplete.categories.performance.auditRefs = [
      { id: "interactive", weight: 1 },
    ];
    incomplete.audits.interactive = { scoreDisplayMode: "error" };
    const problems = inspectReport(incomplete, options).problems;
    expect(problems).toContain("scored audit failed: interactive");
    expect(
      problems.some((problem) => problem.includes("results may be incomplete")),
    ).toBe(true);
    delete incomplete.audits.interactive;
    expect(inspectReport(incomplete, options).problems).toContain(
      "scored audit missing: interactive",
    );
    incomplete.categories.seo.auditRefs = [];
    expect(inspectReport(incomplete, options).problems).toContain(
      "scored audits missing for category: seo",
    );
  });

  it("rejects the wrong page or form factor even when all scores are perfect", () => {
    const wrong = report();
    wrong.finalUrl = "https://example.test/other/";
    wrong.configSettings.formFactor = "desktop";
    const problems = inspectReport(wrong, options).problems;
    expect(problems.some((problem) => problem.includes("not mobile"))).toBe(
      true,
    );
    expect(
      problems.some((problem) =>
        problem.includes("not https://example.test/OpenSesame/"),
      ),
    ).toBe(true);
  });

  it("rejects a report whose fetch time is in the future", () => {
    const future = report();
    future.fetchTime = new Date(Date.now() + 60_000).toISOString();
    expect(
      inspectReport(future, options).problems.some((problem) =>
        problem.includes("stale or missing fetchTime"),
      ),
    ).toBe(true);
  });
});

it.skipIf(process.platform === "win32")(
  "invokes the pinned Lighthouse through npm exec for each form factor",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "score-wrapper-test-"));
    const argsPath = join(dir, "args.json");
    const originalPath = process.env.PATH;
    const originalArgs = process.env.SCORE_TEST_ARGS;
    writeFileSync(
      join(dir, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.SCORE_TEST_ARGS, JSON.stringify(args));
const output = args.find((arg) => arg.startsWith("--output-path=")).slice(14);
const finalUrl = args.find((arg) => arg.startsWith("https://"));
const formFactor = args.includes("--preset=desktop") ? "desktop" : "mobile";
fs.writeFileSync(output, JSON.stringify({
  fetchTime: new Date().toISOString(), finalUrl, configSettings: { formFactor },
  categories: Object.fromEntries(["performance", "accessibility", "best-practices", "seo"].map((id) => [id, { score: 1, auditRefs: [{ id, weight: 1 }] }])),
  audits: Object.fromEntries(["performance", "accessibility", "best-practices", "seo"].map((id) => [id, { scoreDisplayMode: "numeric" }])),
}));
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
    process.env.SCORE_TEST_ARGS = argsPath;
    try {
      for (const formFactor of ["desktop", "mobile"]) {
        const result = await runLighthouse({
          targetUrl,
          withBrowser: (audit) => audit(1234),
          reportPath: join(dir, "report.json"),
          timeout: 10_000,
          attempts: 1,
          children: new Set(),
          formFactor,
        });
        expect(result.passed).toBe(true);
        const args = JSON.parse(readFileSync(argsPath, "utf8"));
        expect(args.slice(0, 5)).toEqual([
          "exec",
          "--yes",
          "--package=lighthouse@12.8.2",
          "--",
          "lighthouse",
        ]);
        expect(args.includes("--preset=desktop")).toBe(
          formFactor === "desktop",
        );
      }
    } finally {
      if (originalPath === undefined)
        Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = originalPath;
      if (originalArgs === undefined)
        Reflect.deleteProperty(process.env, "SCORE_TEST_ARGS");
      else process.env.SCORE_TEST_ARGS = originalArgs;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retains every attempt and does not pass by picking a favorable run",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "score-samples-test-"));
    const originalPath = process.env.PATH;
    const originalCount = process.env.SCORE_TEST_COUNT;
    const originalPorts = process.env.SCORE_TEST_PORTS;
    const countPath = join(dir, "count");
    const portsPath = join(dir, "ports");
    writeFileSync(
      join(dir, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SCORE_TEST_PORTS, args.find((arg) => arg.startsWith("--port=")) + "\\n");
const n = fs.existsSync(process.env.SCORE_TEST_COUNT) ? Number(fs.readFileSync(process.env.SCORE_TEST_COUNT)) + 1 : 1;
fs.writeFileSync(process.env.SCORE_TEST_COUNT, String(n));
const output = args.find((arg) => arg.startsWith("--output-path=")).slice(14);
const finalUrl = args.find((arg) => arg.startsWith("https://"));
fs.writeFileSync(output, JSON.stringify({
  fetchTime: new Date().toISOString(), finalUrl, configSettings: { formFactor: "mobile" },
  categories: Object.fromEntries(["performance", "accessibility", "best-practices", "seo"].map((id) => [id, { score: id === "performance" && n === 1 ? 0.9 : 1, auditRefs: [{ id, weight: 1 }] }])),
  audits: Object.fromEntries(["performance", "accessibility", "best-practices", "seo"].map((id) => [id, { scoreDisplayMode: "numeric" }])),
}));
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
    process.env.SCORE_TEST_COUNT = countPath;
    process.env.SCORE_TEST_PORTS = portsPath;
    try {
      let browsers = 0;
      const result = await runLighthouse({
        targetUrl,
        withBrowser: (audit) => audit(1234 + browsers++),
        reportPath: join(dir, "report.json"),
        timeout: 10_000,
        attempts: 2,
        children: new Set(),
        formFactor: "mobile",
      });
      expect(result.passed).toBe(false);
      expect(browsers).toBe(2);
      expect(readFileSync(portsPath, "utf8").trim().split("\n")).toEqual([
        "--port=1234",
        "--port=1235",
      ]);
      expect(result.samples).toHaveLength(2);
      expect(
        result.samples.map((sample) => sample.categories.performance),
      ).toEqual([0.9, 1]);
      for (const sample of result.samples) {
        expect(
          JSON.parse(readFileSync(sample.reportPath, "utf8")),
        ).toBeTruthy();
      }
    } finally {
      if (originalPath === undefined)
        Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = originalPath;
      if (originalCount === undefined)
        Reflect.deleteProperty(process.env, "SCORE_TEST_COUNT");
      else process.env.SCORE_TEST_COUNT = originalCount;
      if (originalPorts === undefined)
        Reflect.deleteProperty(process.env, "SCORE_TEST_PORTS");
      else process.env.SCORE_TEST_PORTS = originalPorts;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
