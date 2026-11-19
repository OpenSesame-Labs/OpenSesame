/** Compare guest admission using the same synthetic Identity cookie. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const baseRepo = resolve(process.env.BASE_REPO || "/baseline");
const headRepo = resolve(process.env.HEAD_REPO || "/head");
const out = resolve(process.env.EVIDENCE_OUT || "/out");
const identity = "http://127.0.0.1:18890";
const baseOrigin = "http://127.0.0.1:5198";
const headOrigin = "http://127.0.0.1:5199";
const { chromium } = createRequire(join(headRepo, "package.json"))(
  "@playwright/test",
);
const children = [];
function start(script, args, cwd, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
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
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`Fixture exited: ${child.log}`);
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Fixture did not start: ${child.log}`);
}
function pages(repo, port) {
  return start(
    join(repo, "node_modules/vite/bin/vite.js"),
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
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
}
const fixture = `
  import { serve } from '@hono/node-server';
  import { createControlPlane } from './packages/control-plane/src/create-app.ts';
  const {app}=createControlPlane({config:{port:18890,publicUrl:${JSON.stringify(identity)},issuer:${JSON.stringify(identity)},corsOrigins:[${JSON.stringify(baseOrigin)},${JSON.stringify(headOrigin)}]}});
  serve({fetch:app.fetch,port:18890,hostname:'127.0.0.1'});
`;
async function open(context, origin, repo) {
  const page = await context.newPage();
  await page.goto(`${origin}/OpenSesame/`, { waitUntil: "networkidle" });
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
  return { page, skip };
}
async function measure(locator) {
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect(),
      hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      hit: !!hit && element.contains(hit),
    };
  });
}
async function capture(page, file) {
  await page.screenshot({ path: join(out, file) });
  return {
    file,
    sha256: createHash("sha256")
      .update(readFileSync(join(out, file)))
      .digest("hex"),
  };
}
const cookieStatus = (page) =>
  page.evaluate(
    (base) =>
      fetch(`${base}/v1/principals/me`, { credentials: "include" }).then(
        (r) => r.status,
      ),
    identity,
  );
let browser;
mkdirSync(out, { recursive: true });
try {
  const server = start(
    join(headRepo, "node_modules/tsx/dist/cli.mjs"),
    ["-e", fixture],
    headRepo,
    { OPENSESAME_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
  );
  const before = pages(baseRepo, 5198),
    after = pages(headRepo, 5199);
  await Promise.all([
    ready(`${identity}/v1/principals/me`, server),
    ready(`${baseOrigin}/OpenSesame/`, before),
    ready(`${headOrigin}/OpenSesame/`, after),
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
    const baseline = await open(context, baseOrigin, baseRepo),
      head = await open(context, headOrigin, headRepo);
    const created = await head.page.evaluate(
      (base) =>
        fetch(`${base}/v1/principals/provisional`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        }).then((r) => r.status),
      identity,
    );
    assert.equal(created, 201, "fixture sign-in failed");
    const originalCookie = await context.cookies(identity);
    assert.ok(originalCookie.length, "fixture cookie missing");
    assert.equal(
      await cookieStatus(baseline.page),
      200,
      "baseline did not receive the signed-in cookie",
    );
    const baseSkip = await measure(baseline.skip);
    await baseline.skip.tap();
    const baseSignOut = baseline.page.getByRole("button", {
      name: "Sign out",
      exact: true,
    });
    const outcome = await Promise.race([
      baseline.page
        .waitForURL(/\/vault(?:\/|$)/, { timeout: 30000 })
        .then(() => "guest-vault"),
      baseSignOut
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "sign-out-required"),
    ]);
    if (outcome === "guest-vault")
      await baseline.page
        .getByRole("button", { name: "Lock vault" })
        .locator("visible=true")
        .first()
        .waitFor({ timeout: 30000 });
    const baseButton =
      outcome === "sign-out-required" ? await measure(baseSignOut) : null;
    const baseImage = await capture(baseline.page, `baseline-${width}.png`);
    await context.clearCookies();
    await context.addCookies(originalCookie);
    assert.equal(
      await cookieStatus(head.page),
      200,
      "original cookie could not be restored for head comparison",
    );
    const headSkip = await measure(head.skip);
    await head.skip.tap();
    await head.page
      .getByText(
        "Sign out of the current account first, then continue as a fresh guest.",
        { exact: true },
      )
      .waitFor({ state: "visible", timeout: 15000 });
    const signOut = head.page.getByRole("button", {
      name: "Sign out",
      exact: true,
    });
    await signOut.waitFor({ state: "visible", timeout: 15000 });
    const button = await measure(signOut);
    assert.ok(
      button.hit &&
        button.width >= 44 &&
        button.height >= 44 &&
        button.x >= 0 &&
        button.y >= 0 &&
        button.x + button.width <= width &&
        button.y + button.height <= height,
      "head sign-out control is not fully usable",
    );
    const headImage = await capture(head.page, `head-${width}.png`);
    await signOut.tap();
    await head.skip.tap();
    await head.page.waitForURL(/\/vault(?:\/|$)/, { timeout: 30000 });
    const oldCookieStatus = await cookieStatus(head.page);
    assert.equal(
      oldCookieStatus,
      401,
      "old fixture cookie still authenticates",
    );
    screens.push({
      width,
      height,
      baseline: { outcome, skip: baseSkip, signOut: baseButton, ...baseImage },
      head: {
        outcome: "sign-out-required",
        skip: headSkip,
        signOut: button,
        oldCookieStatus,
        ...headImage,
      },
    });
    await context.close();
    console.log(
      `PASS ${width}px: baseline ${outcome}; head requires sign-out and retry succeeds`,
    );
  }
  writeFileSync(
    join(out, "manifest.json"),
    `${JSON.stringify(
      {
        baseline: {
          source: process.env.BASELINE_SHA,
          tree: process.env.BASELINE_TREE,
        },
        head: { source: process.env.HEAD_SHA, tree: process.env.HEAD_TREE },
        setup:
          "One browser context and one disposable Identity cookie; the original cookie is restored before head.",
        network: "Loopback eligibility seam",
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
