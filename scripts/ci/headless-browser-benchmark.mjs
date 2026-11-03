#!/usr/bin/env node
/**
 * Compare headless browser stacks for CD screenshot legs.
 * Outputs JSON rows: install_bytes, install_ms, capture_ms, screenshots_ok, notes.
 *
 *   node scripts/ci/headless-browser-benchmark.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME_VERSION = "156.0.8078.4";
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function dirSizeBytes(root) {
  if (!existsSync(root)) return 0;
  const out = spawnSync("du", ["-sb", root], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout) return 0;
  const first = out.stdout.trim().split(/\s+/)[0];
  const n = Number(first);
  return Number.isFinite(n) ? n : 0;
}

function timed(fn) {
  const start = Date.now();
  const value = fn();
  return { value, ms: Date.now() - start };
}

async function timedAsync(fn) {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

function resolveBenchDist() {
  const fromEnv = process.env.OPENSESAME_HEADLESS_BENCH_DIST;
  if (fromEnv !== undefined && existsSync(join(fromEnv, "index.html"))) {
    return resolve(fromEnv);
  }
  const pagesDist = join(repoRoot, "apps/pages/dist");
  if (existsSync(join(pagesDist, "index.html"))) return pagesDist;
  return null;
}

async function serveDist(dist) {
  const base = "/OpenSesame/";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith(base)) rel = rel.slice(base.length);
    if (rel === "" || rel.endsWith("/"))
      rel = `${rel}index.html`.replace(/\/+/g, "/");
    const file = join(dist, rel.replace(/^\//, ""));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.listen(0, "127.0.0.1", () => resolveListen(undefined));
    server.on("error", reject);
  });
  const addr = server.address();
  if (addr === null || !("port" in addr)) {
    throw new Error("bench server failed to bind");
  }
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    href: `${origin}${base}`,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose(undefined));
      }),
  };
}

async function captureThreeWithPlaywrightCore(executablePath, pageUrl, outDir) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const paths = [
      join(outDir, "shot-1.png"),
      join(outDir, "shot-2.png"),
      join(outDir, "shot-3.png"),
    ];
    await page.screenshot({ path: paths[0], animations: "disabled" });
    await page.evaluate(() => window.scrollTo(0, 200));
    await page.screenshot({ path: paths[1], animations: "disabled" });
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.screenshot({ path: paths[2], animations: "disabled" });
    for (const p of paths) {
      const bytes = readFileSync(p);
      if (bytes.length < 1000) {
        throw new Error(`screenshot too small: ${p}`);
      }
    }
    return paths;
  } finally {
    await browser.close();
  }
}

async function runPlaywrightCoreBench(label, prepare) {
  const row = {
    backend: label,
    install_bytes: 0,
    install_ms: 0,
    capture_ms: 0,
    dom_assert_ms: 0,
    screenshots_ok: false,
    dom_assert_ok: false,
    notes: "",
  };
  const dist = resolveBenchDist();
  if (dist === null) {
    row.notes = "skipped: no apps/pages/dist for bench";
    return row;
  }
  let cacheDir = "";
  try {
    const prepared = await timedAsync(async () => prepare());
    row.install_ms = prepared.ms;
    cacheDir = prepared.value.cacheDir;
    row.install_bytes = prepared.value.installBytes;
    const server = await serveDist(dist);
    const outDir = mkdtempSync(join(tmpdir(), "headless-bench-"));
    try {
      const capture = await timedAsync(async () =>
        captureThreeWithPlaywrightCore(
          prepared.value.executablePath,
          server.href,
          outDir,
        ),
      );
      row.capture_ms = capture.ms;
      row.screenshots_ok = true;
      row.notes = `shots=${capture.value.length}`;
    } finally {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  } catch (error) {
    row.notes = error instanceof Error ? error.message : "bench failed";
  } finally {
    if (cacheDir.length > 0 && cacheDir.includes("/tmp/")) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }
  return row;
}

async function benchSystemChromium() {
  return runPlaywrightCoreBench(
    "playwright-core + system chromium",
    async () => {
      const candidates = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome-stable",
      ];
      const hit = candidates.find((p) => existsSync(p));
      if (hit === undefined) {
        throw new Error("system chromium not installed");
      }
      return { executablePath: hit, cacheDir: "", installBytes: 0 };
    },
  );
}

async function benchCftHeadlessShell() {
  return runPlaywrightCoreBench(
    "playwright-core + @puppeteer/browsers chrome-headless-shell",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "cft-shell-"));
      const ran = spawnSync(
        "npx",
        [
          "--yes",
          "@puppeteer/browsers@3.2.6",
          "install",
          `chrome-headless-shell@${CHROME_VERSION}`,
          "--path",
          cacheDir,
        ],
        { cwd: repoRoot, stdio: "pipe", encoding: "utf8" },
      );
      if (ran.status !== 0) {
        throw new Error(ran.stderr || "cft install failed");
      }
      const executablePath = join(
        cacheDir,
        "chrome-headless-shell",
        `linux-${CHROME_VERSION}`,
        "chrome-headless-shell-linux64",
        "chrome-headless-shell",
      );
      if (!existsSync(executablePath)) {
        throw new Error("cft binary missing after install");
      }
      return {
        executablePath,
        cacheDir,
        installBytes: dirSizeBytes(cacheDir),
      };
    },
  );
}

async function benchPlaywrightHeadlessShell() {
  return runPlaywrightCoreBench(
    "playwright-core + playwright install chromium-headless-shell",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "pw-hshell-"));
      const ran = spawnSync(
        "npx",
        ["playwright", "install", "chromium-headless-shell"],
        {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf8",
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir },
        },
      );
      if (ran.status !== 0) {
        throw new Error(
          ran.stderr || "playwright headless-shell install failed",
        );
      }
      const { findChromium } = await import(
        pathToFileURL(
          join(repoRoot, "apps/pages/scripts/duress/find-chromium.mjs"),
        ).href
      );
      process.env.PLAYWRIGHT_CHROMIUM = "";
      process.env.HOME = process.env.HOME ?? tmpdir();
      const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;
      const discovery = findChromium();
      process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
      if (!discovery.path) {
        throw new Error("playwright headless-shell binary not discovered");
      }
      return {
        executablePath: discovery.path,
        cacheDir,
        installBytes: dirSizeBytes(cacheDir),
      };
    },
  );
}

async function benchPlaywrightFullChromium() {
  return runPlaywrightCoreBench(
    "playwright-core + playwright install chromium",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "pw-chromium-"));
      const ran = spawnSync("npx", ["playwright", "install", "chromium"], {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir },
      });
      if (ran.status !== 0) {
        throw new Error(ran.stderr || "playwright chromium install failed");
      }
      const { findChromium } = await import(
        pathToFileURL(
          join(repoRoot, "apps/pages/scripts/duress/find-chromium.mjs"),
        ).href
      );
      const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;
      const discovery = findChromium();
      process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
      if (!discovery.path) {
        throw new Error("playwright chromium binary not discovered");
      }
      return {
        executablePath: discovery.path,
        cacheDir,
        installBytes: dirSizeBytes(cacheDir),
      };
    },
  );
}

function emptyRow(backend) {
  return {
    backend,
    install_bytes: 0,
    install_ms: 0,
    capture_ms: 0,
    dom_assert_ms: 0,
    screenshots_ok: false,
    dom_assert_ok: false,
    notes: "",
  };
}

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

async function benchAgentBrowser() {
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

async function benchLightpanda() {
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
    const install = timed(() => {
      const pkg = spawnSync(
        "npm",
        ["install", "--no-save", "@lightpanda/browser@1.6.0"],
        { cwd: workDir, stdio: "pipe", encoding: "utf8" },
      );
      if (pkg.status !== 0) {
        throw new Error(pkg.stderr || "lightpanda npm install failed");
      }
      const browserInstall = spawnSync(
        "npx",
        ["@lightpanda/browser", "install"],
        { cwd: workDir, stdio: "pipe", encoding: "utf8" },
      );
      if (browserInstall.status !== 0) {
        throw new Error(
          browserInstall.stderr || "lightpanda browser install failed",
        );
      }
    });
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

async function benchStagehand() {
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

async function main() {
  const rows = [];
  rows.push(await benchSystemChromium());
  rows.push(await benchCftHeadlessShell());
  rows.push(await benchPlaywrightHeadlessShell());
  rows.push(await benchPlaywrightFullChromium());
  rows.push(await benchAgentBrowser());
  rows.push(await benchLightpanda());
  rows.push(await benchStagehand());

  const scored = rows.filter((r) => r.screenshots_ok);
  scored.sort(
    (a, b) => a.install_ms + a.capture_ms - (b.install_ms + b.capture_ms),
  );
  const winner = scored[0] ?? null;

  const report = {
    generated_at: new Date().toISOString(),
    github_run_id: process.env.GITHUB_RUN_ID ?? null,
    github_repository: process.env.GITHUB_REPOSITORY ?? null,
    dist: resolveBenchDist(),
    winner: winner?.backend ?? null,
    rows,
  };

  const outPath =
    process.env.HEADLESS_BENCH_OUT ??
    join(repoRoot, "artifacts/headless-browser-benchmark.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "\n| Backend | install_ms | install_MiB | capture_ms | dom_assert_ms | shots | dom | notes |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
  for (const row of rows) {
    const mib = (row.install_bytes / (1024 * 1024)).toFixed(1);
    console.log(
      `| ${row.backend} | ${row.install_ms} | ${mib} | ${row.capture_ms} | ${row.dom_assert_ms ?? 0} | ${row.screenshots_ok ? "yes" : "no"} | ${row.dom_assert_ok ? "yes" : "no"} | ${row.notes.replace(/\|/g, "/")} |`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
