import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { signalTree } from "./web-score-browser.mjs";
import { samePage } from "./web-score-common.mjs";

const requiredCategories = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];

function windowsArg(value) {
  return /^[A-Za-z0-9_./:@=+\\-]+$/u.test(value)
    ? value
    : `"${value.replaceAll('"', '""')}"`;
}

function lighthouseCommand(args) {
  if (process.platform !== "win32") return { command: "npm", args };
  const line = ["npm", ...args].map(windowsArg).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", line],
  };
}

function runChild(args, { timeout, children }) {
  const { command, args: commandArgs } = lighthouseCommand(args);
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    detached: true,
    windowsHide: true,
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signalTree(child.pid, "SIGTERM");
      setTimeout(() => signalTree(child.pid, "SIGKILL"), 2_000).unref();
      reject(new Error(`${command} timed out after ${timeout} ms`));
    }, timeout);
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };
    child.once("error", (error) => {
      children.delete(child);
      finish(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      finish(null, code ?? signal);
    });
  });
}

function readReport(reportPath) {
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function hasFreshFetchTime(report, startedAt) {
  const fetchedAt = Date.parse(report.fetchTime ?? "");
  return (
    Number.isFinite(fetchedAt) &&
    fetchedAt >= startedAt - 5_000 &&
    fetchedAt <= Date.now() + 5_000
  );
}

export function inspectReport(
  report,
  { exitCode, targetUrl, startedAt, formFactor, expectApp = false },
) {
  const problems = [];
  if (exitCode !== 0) problems.push(`Lighthouse exited ${exitCode}`);
  if (report.configSettings?.formFactor !== formFactor) {
    problems.push(
      `form factor is ${report.configSettings?.formFactor ?? "unknown"}, not ${formFactor}`,
    );
  }
  if (!samePage(report.finalUrl, targetUrl.href)) {
    problems.push(
      `ended at ${report.finalUrl ?? "an unknown URL"}, not ${targetUrl.href}`,
    );
  }
  if (report.runtimeError) {
    problems.push(
      `runtime error: ${report.runtimeError.message ?? report.runtimeError.code}`,
    );
  }
  if (!hasFreshFetchTime(report, startedAt)) {
    problems.push(`stale or missing fetchTime (${report.fetchTime ?? "none"})`);
  }
  if (report.runWarnings?.length) {
    problems.push(
      `Lighthouse reported warnings: ${report.runWarnings.join("; ")}`,
    );
  }
  for (const id of requiredCategories) {
    const refs = report.categories?.[id]?.auditRefs;
    if (!Array.isArray(refs) || !refs.some((ref) => ref.weight > 0)) {
      problems.push(`scored audits missing for category: ${id}`);
    }
  }
  for (const category of Object.values(report.categories ?? {})) {
    for (const ref of category.auditRefs ?? []) {
      if (ref.weight > 0 && !report.audits?.[ref.id]) {
        problems.push(`scored audit missing: ${ref.id}`);
      } else if (
        ref.weight > 0 &&
        report.audits[ref.id].scoreDisplayMode === "error"
      ) {
        problems.push(`scored audit failed: ${ref.id}`);
      }
    }
  }
  if (expectApp) {
    const lcp = report.audits?.[
      "largest-contentful-paint-element"
    ]?.details?.items
      ?.flatMap((group) => group.items ?? [])
      .find((item) => item.node)?.node;
    if (!lcp) {
      problems.push("could not identify the largest painted element");
    } else if (
      /\b(?:boot(?:__[\w-]+)?|static-door(?:__[\w-]+)?)(?![\w-])/u.test(
        `${lcp.selector} ${lcp.snippet}`,
      )
    ) {
      problems.push(
        "the largest paint was the startup placeholder, not the app",
      );
    }
  }
  const categories = Object.fromEntries(
    Object.entries(report.categories ?? {}).map(([id, category]) => [
      id,
      category.score,
    ]),
  );
  const below = requiredCategories.filter((id) => categories[id] !== 1);
  if (below.length > 0) {
    problems.push(`categories below 1.0: ${below.join(", ")}`);
  }
  return { categories, problems };
}

async function auditLighthouse({
  attempt,
  targetUrl,
  port,
  reportPath,
  timeout,
  children,
  formFactor,
  expectApp,
}) {
  const startedAt = Date.now();
  rmSync(reportPath, { force: true });
  let exitCode;
  try {
    exitCode = await runChild(
      [
        "exec",
        "--yes",
        "--package=lighthouse@12.8.2",
        "--",
        "lighthouse",
        targetUrl.href,
        `--port=${port}`,
        ...(formFactor === "desktop" ? ["--preset=desktop"] : []),
        "--quiet",
        "--no-enable-error-reporting",
        "--output=json",
        `--output-path=${reportPath}`,
      ],
      { timeout, children },
    );
  } catch (error) {
    return {
      categories: {},
      problems: [`could not run Lighthouse: ${error.message}`],
    };
  }
  const report = readReport(reportPath);
  if (!report) {
    return {
      categories: {},
      problems: [`Lighthouse exited ${exitCode} without a report`],
    };
  }
  const result = inspectReport(report, {
    exitCode,
    targetUrl,
    startedAt,
    formFactor,
    expectApp,
  });
  console.log(
    `Lighthouse ${formFactor} attempt ${attempt}: ${JSON.stringify(result.categories)}`,
  );
  return result;
}

export async function runLighthouse({
  targetUrl,
  port,
  reportPath,
  timeout,
  attempts,
  children,
  formFactor = "desktop",
  expectApp = false,
}) {
  if (formFactor !== "desktop" && formFactor !== "mobile") {
    throw new Error(`unsupported Lighthouse form factor: ${formFactor}`);
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Lighthouse attempts must be a positive integer");
  }
  const samples = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Keep every sample. Selecting the best score hides variability and can
    // make a slower experience appear to pass.
    const samplePath =
      attempts === 1
        ? reportPath
        : `${reportPath.replace(/\.json$/u, "")}.attempt-${attempt}.json`;
    const result = await auditLighthouse({
      attempt,
      targetUrl,
      port,
      reportPath: samplePath,
      timeout,
      children,
      formFactor,
      expectApp,
    });
    samples.push({ ...result, reportPath: samplePath });
    for (const problem of result.problems) {
      console.error(
        `FAIL: Lighthouse ${formFactor} attempt ${attempt}: ${problem}`,
      );
    }
  }
  return {
    passed: samples.every((sample) => sample.problems.length === 0),
    samples,
  };
}
