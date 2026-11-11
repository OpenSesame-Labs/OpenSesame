/**
 * Headless browser benchmark backends that do not launch Chromium through
 * playwright-core directly: the agent-browser CLI, Lightpanda over CDP, and
 * the Stagehand package install.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  dirSizeBytes,
  emptyRow,
  repoRoot,
  resolveBenchDist,
  serveDist,
  timed,
  timedAsync,
} from "./headless-browser-benchmark-support.mjs";

function agentBrowserHome() {
  const home = process.env.HOME ?? tmpdir();
  return join(home, ".agent-browser");
}

function runAgentBrowserCli(pkgRoot, args, session) {
  const cliArgs = ["exec", "--", "agent-browser"];
  if (session !== undefined) {
    cliArgs.push("--session", session);
  }
  cliArgs.push(...args);
  return spawnSync("npm", cliArgs, {
    cwd: pkgRoot,
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function benchAgentBrowser() {
  const row = emptyRow("agent-browser CLI (install + open + 3× screenshot)");
  const dist = resolveBenchDist();
  if (dist === null) {
    row.notes = "skipped: no dist";
    return row;
  }
  const pkgRoot = join(repoRoot, "packages/cua-password-reset");
  const server = await serveDist(dist);
  const outDir = mkdtempSync(join(tmpdir(), "agent-bench-"));
  const session = `bench-${process.pid}-${Date.now()}`;
  try {
    runAgentBrowserCli(pkgRoot, ["close", "--all"]);
    const install = timed(() => {
      const ran = runAgentBrowserCli(pkgRoot, ["install"]);
      if (ran.status !== 0) {
        throw new Error(
          ran.stderr || ran.stdout || "agent-browser install failed",
        );
      }
    });
    row.install_ms = install.ms;
    row.install_bytes = dirSizeBytes(agentBrowserHome());

    const capture = await timedAsync(async () => {
      let ran = runAgentBrowserCli(pkgRoot, ["open", server.href], session);
      if (ran.status !== 0) {
        throw new Error(
          ran.stderr || ran.stdout || "agent-browser open failed",
        );
      }
      await delay(500);
      const paths = [
        join(outDir, "shot-1.png"),
        join(outDir, "shot-2.png"),
        join(outDir, "shot-3.png"),
      ];
      for (let index = 0; index < paths.length; index += 1) {
        if (index > 0) {
          ran = runAgentBrowserCli(pkgRoot, ["scroll", "down", "200"], session);
          if (ran.status !== 0) {
            throw new Error(ran.stderr || "agent-browser scroll failed");
          }
        }
        ran = runAgentBrowserCli(
          pkgRoot,
          ["screenshot", paths[index]],
          session,
        );
        if (ran.status !== 0) {
          throw new Error(ran.stderr || "agent-browser screenshot failed");
        }
        const bytes = readFileSync(paths[index]);
        if (bytes.length < 1000) {
          throw new Error(`screenshot too small: ${paths[index]}`);
        }
      }
      runAgentBrowserCli(pkgRoot, ["close"], session);
    });
    row.capture_ms = capture.ms;
    row.screenshots_ok = true;
    row.notes = "shots=3";
  } catch (error) {
    row.notes = error instanceof Error ? error.message : "agent-browser failed";
  } finally {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
  return row;
}

function installLightpanda(workDir) {
  const pkg = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-save", "@lightpanda/browser@1.6.0"],
    { cwd: workDir, stdio: "pipe", encoding: "utf8" },
  );
  if (pkg.status !== 0) {
    throw new Error(pkg.stderr || "lightpanda npm install failed");
  }
  const browserInstall = spawnSync("npx", ["@lightpanda/browser", "install"], {
    cwd: workDir,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (browserInstall.status !== 0) {
    throw new Error(
      browserInstall.stderr || "lightpanda browser install failed",
    );
  }
}

export async function benchLightpanda() {
  const row = emptyRow(
    "@lightpanda/browser + playwright-core connectOverCDP (DOM asserts)",
  );
  const dist = resolveBenchDist();
  if (dist === null) {
    row.notes = "skipped: no dist";
    return row;
  }
  const workDir = mkdtempSync(join(tmpdir(), "lp-bench-"));
  let proc = null;
  const server = await serveDist(dist);
  try {
    const install = timed(() => installLightpanda(workDir));
    row.install_ms = install.ms;
    row.install_bytes = dirSizeBytes(join(workDir, "node_modules"));

    const domLeg = await timedAsync(async () => {
      const modulePath = join(
        workDir,
        "node_modules/@lightpanda/browser/dist/index.js",
      );
      const { lightpanda } = await import(pathToFileURL(modulePath).href);
      const port = 19222 + Math.floor(Math.random() * 1000);
      proc = await lightpanda.serve({ host: "127.0.0.1", port });
      const { chromium } = await import("playwright-core");
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        const context = browser.contexts()[0];
        if (context === undefined) {
          throw new Error("lightpanda CDP exposed no browser context");
        }
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(server.href, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        const title = await page.title();
        if (title.length === 0) {
          throw new Error("empty document title");
        }
        const bodyLength = await page.evaluate(
          () => document.body?.innerText?.length ?? 0,
        );
        if (bodyLength < 1) {
          throw new Error("empty document body");
        }
        await page.evaluate(() => window.scrollTo(0, 240));
        const scrolled = await page.evaluate(() => window.scrollY);
        if (scrolled < 1) {
          throw new Error("scroll did not move");
        }
        try {
          await page.screenshot({
            path: join(workDir, "lightpanda-shot.png"),
            animations: "disabled",
          });
          row.screenshots_ok = existsSync(join(workDir, "lightpanda-shot.png"));
        } catch {
          row.notes = "dom ok; screenshot unsupported";
        }
      } finally {
        await browser.close();
      }
    });
    row.dom_assert_ms = domLeg.ms;
    row.dom_assert_ok = true;
    if (row.notes.length === 0) {
      row.notes = row.screenshots_ok
        ? "dom+screenshot"
        : "dom asserts only (CDP)";
    }
  } catch (error) {
    row.notes = error instanceof Error ? error.message : "lightpanda failed";
  } finally {
    await server.close();
    if (proc !== null) {
      proc.kill();
    }
    rmSync(workDir, { recursive: true, force: true });
  }
  return row;
}

export async function benchStagehand() {
  const row = {
    backend: "@browserbasehq/stagehand + playwright-core",
    install_bytes: 0,
    install_ms: 0,
    capture_ms: 0,
    screenshots_ok: false,
    notes: "",
  };
  try {
    const install = timed(() => {
      const cacheDir = mkdtempSync(join(tmpdir(), "stagehand-"));
      const ran = spawnSync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-save",
          "@browserbasehq/stagehand@4.3.0",
          "playwright-core@1.64.1",
        ],
        { cwd: cacheDir, stdio: "pipe", encoding: "utf8" },
      );
      if (ran.status !== 0) {
        throw new Error(ran.stderr || "stagehand install failed");
      }
      return cacheDir;
    });
    row.install_ms = install.ms;
    row.install_bytes = dirSizeBytes(join(install.value, "node_modules"));
    row.notes =
      "package install timed; Stagehand requires LLM env for acts — CD keeps deterministic playwright-core screenshots";
  } catch (error) {
    row.notes = error instanceof Error ? error.message : "stagehand failed";
  }
  return row;
}
