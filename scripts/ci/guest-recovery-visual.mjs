/** Compare guest admission using the same synthetic Identity cookie. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";

const baseRepo = resolve(process.env.BASE_REPO || "/baseline");
const headRepo = resolve(process.env.HEAD_REPO || "/head");
const baseDist = resolve(
  process.env.BASE_DIST || join(baseRepo, "apps/pages/dist"),
);
const headDist = resolve(
  process.env.HEAD_DIST || join(headRepo, "apps/pages/dist"),
);
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
async function build(repo, origin, dist) {
  const profile = JSON.parse(
    readFileSync(join(repo, "apps/pages/public/security-profile.json"), "utf8"),
  );
  assert.equal(profile.profile, "loopback_development");
  assert.equal(profile.canonicalOrigin, origin);
  const child = start(
    join(repo, "node_modules/vite/bin/vite.js"),
    ["build", "--outDir", dist, "--emptyOutDir"],
    join(repo, "apps/pages"),
    {
      OPENSESAME_BUILD_MODE: "hardened",
      PAGES_DEPLOYMENT_PROFILE: "loopback_development",
      PAGES_CANONICAL_ORIGIN: origin,
      VITE_BASE: "/OpenSesame/",
      OPENSESAME_CAPABILITY_PROFILE: join(
        repo,
        "apps/pages/capability-profiles/minimal-local.json",
      ),
    },
  );
  await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : fail(new Error(`Static build failed: ${child.log}`)),
    );
  });
  console.log(`Built ${origin} from ${repo}`);
}
function serve(dist, port) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (path === "/OpenSesame/os-runtime-config.json") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ identityApi: identity }));
      return;
    }
    if (!path.startsWith("/OpenSesame/")) {
      response.writeHead(404).end();
      return;
    }
    let file = resolve(
      dist,
      `.${decodeURIComponent(path.slice("/OpenSesame".length))}`,
    );
    if (file === dist) file = join(dist, "index.html");
    if (!file.startsWith(`${dist}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const actual =
      existsSync(file) && statSync(file).isFile()
        ? file
        : join(dist, "index.html");
    response.writeHead(200, {
      "content-type": types[extname(actual)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(actual));
  });
  return new Promise((done, fail) =>
    server.once("error", fail).listen(port, "127.0.0.1", () => done(server)),
  );
}
const fixture = `
  import { serve } from '@hono/node-server';
  import { createControlPlane } from './packages/control-plane/src/create-app.ts';
  const {app}=createControlPlane({config:{port:18890,publicUrl:${JSON.stringify(identity)},issuer:${JSON.stringify(identity)},corsOrigins:[${JSON.stringify(baseOrigin)},${JSON.stringify(headOrigin)}]}});
  serve({fetch:app.fetch,port:18890,hostname:'127.0.0.1'});
`;
async function open(context, origin) {
  const page = await context.newPage();
  await page.goto(`${origin}/OpenSesame/`, { waitUntil: "networkidle" });
  const skip = page.getByRole("button", {
    name: "Skip sign-in and continue as guest",
  });
  await skip.waitFor({ timeout: 30000 });
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
const servers = [];
mkdirSync(out, { recursive: true });
try {
  if (process.env.EVIDENCE_SKIP_BUILD !== "1") {
    await build(baseRepo, baseOrigin, baseDist);
    await build(headRepo, headOrigin, headDist);
  }
  const server = start(
    join(headRepo, "node_modules/tsx/dist/cli.mjs"),
    ["-e", fixture],
    headRepo,
    { OPENSESAME_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
  );
  servers.push(await serve(baseDist, 5198), await serve(headDist, 5199));
  await ready(`${identity}/v1/principals/me`, server);
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
      serviceWorkers: "block",
    });
    const baseline = await open(context, baseOrigin),
      head = await open(context, headOrigin);
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
          "One browser context and one provisional Identity session cookie; the original cookie is restored before head.",
        build: "Vite production builds with minimal-local capability profiles",
        deployment:
          "loopback_development; runtime Identity configured to the disposable local server",
        serviceWorkers: "blocked for the isolated comparison",
        screens,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser) await browser.close();
  for (const server of servers) server.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
