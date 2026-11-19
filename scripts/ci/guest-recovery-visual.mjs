/** Disposable guest recovery screenshots, exercised against a local Identity. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const repo = resolve(process.env.REPO_ROOT || "/repo");
const out = resolve(process.env.EVIDENCE_OUT || "/out");
const identityPort = Number(process.env.IDENTITY_PORT || 18890);
const pagesPort = Number(process.env.PAGES_PORT || 5199);
const identity = `http://127.0.0.1:${identityPort}`;
const origin = `http://127.0.0.1:${pagesPort}`;
const pages = `${origin}/OpenSesame/`;
const require = createRequire(join(repo, "package.json"));
const { chromium } = require("@playwright/test");
const children = [];
function start(script, args, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.log = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      child.log = (child.log + data).slice(-5000);
    });
  children.push(child);
  return child;
}
async function ready(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Fixture exited: ${child.log}`);
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Fixture did not start: ${child.log}`);
}
const fixture = `
  import { serve } from '@hono/node-server';
  import { createControlPlane } from './packages/control-plane/src/create-app.ts';
  const { app } = createControlPlane({config: {
    port: ${identityPort}, publicUrl: ${JSON.stringify(identity)},
    issuer: ${JSON.stringify(identity)}, corsOrigins: [${JSON.stringify(origin)}],
  }});
  serve({fetch: app.fetch, port: ${identityPort}, hostname: '127.0.0.1'});
`;
let browser;
mkdirSync(out, { recursive: true });
try {
  const server = start(
    join(repo, "node_modules/tsx/dist/cli.mjs"),
    ["-e", fixture],
    repo,
    {
      OPENSESAME_ENV: "test",
      OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
    },
  );
  const vite = start(
    join(repo, "node_modules/vite/bin/vite.js"),
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(pagesPort),
      "--strictPort",
      "--base",
      "/OpenSesame/",
    ],
    join(repo, "apps/pages"),
    {
      OPENSESAME_BUILD_MODE: "hardened",
      OPENSESAME_CAPABILITY_PROFILE: join(
        repo,
        "apps/pages/capability-profiles/minimal-local.json",
      ),
    },
  );
  await Promise.all([
    ready(`${identity}/v1/principals/me`, server),
    ready(pages, vite),
  ]);
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : {}),
    headless: true,
  });
  const screens = [];
  for (const width of [320, 390]) {
    const height = width === 320 ? 568 : 844;
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(pages, { waitUntil: "networkidle" });
    const skip = page.getByRole("button", {
      name: "Skip sign-in and continue as guest",
    });
    await skip.waitFor({ timeout: 30000 });
    await page.evaluate(
      async ({ repo, identity }) => {
        const settings = await import(
          `/OpenSesame/@fs${repo}/packages/app-core/src/lib/settings.ts`
        );
        const network = await import(
          `/OpenSesame/@fs${repo}/packages/app-core/src/lib/local-network-fetch.ts`
        );
        network.localNetworkFetchSeams.eligible = () => true;
        settings.saveSettings({
          ...settings.loadSettings(),
          identityApi: identity,
        });
      },
      { repo, identity },
    );
    const created = await page.evaluate(
      (base) =>
        fetch(`${base}/v1/principals/provisional`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        }).then((response) => response.status),
      identity,
    );
    assert.equal(created, 201, "fixture sign-in failed");
    assert.ok(
      (await context.cookies(identity)).length,
      "fixture cookie missing",
    );
    await skip.tap();
    await page
      .getByText(
        "Sign out of the current account first, then continue as a fresh guest.",
        { exact: true },
      )
      .waitFor({ state: "visible", timeout: 15000 });
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    await signOut.waitFor({ state: "visible", timeout: 15000 });
    const button = await signOut.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        hit: !!hit && element.contains(hit),
      };
    });
    assert.ok(
      button.hit &&
        button.width >= 44 &&
        button.height >= 44 &&
        button.x >= 0 &&
        button.y >= 0 &&
        button.x + button.width <= width &&
        button.y + button.height <= height,
      "sign-out is covered, too small or outside the viewport",
    );
    const file = `guest-sign-out-${width}.png`;
    await page.screenshot({ path: join(out, file) });
    await signOut.tap();
    await skip.tap();
    await page.waitForURL(/\/vault(?:\/|$)/, { timeout: 30000 });
    const oldCookieStatus = await page.evaluate(
      (base) =>
        fetch(`${base}/v1/principals/me`, { credentials: "include" }).then(
          (response) => response.status,
        ),
      identity,
    );
    assert.equal(
      oldCookieStatus,
      401,
      "old fixture cookie still authenticates",
    );
    screens.push({
      width,
      height,
      button,
      oldCookieStatus,
      file,
      sha256: createHash("sha256")
        .update(readFileSync(join(out, file)))
        .digest("hex"),
    });
    await context.close();
    console.log(
      `PASS ${width}px: sign-out is visible and tappable; guest retry succeeds`,
    );
  }
  writeFileSync(
    join(out, "manifest.json"),
    `${JSON.stringify(
      {
        source: process.env.EVIDENCE_PR_SHA,
        tree: process.env.EVIDENCE_TREE,
        identity: "disposable local Identity",
        network: "loopback eligibility seam",
        screens,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser) await browser.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
