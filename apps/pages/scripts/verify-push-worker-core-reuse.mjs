// Managed-Chromium differential for the classic push wrapper's shared core.
// Build Pages first. This verifies direct core defaulting, the push variant
// marker, the source-hashed import, imported-script update propagation and the
// shell precache while the static origin is offline.
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve } from "./lib/push-worker-harness.mjs";

const dist = path.resolve(
  import.meta.dirname,
  "..",
  process.env.PAGES_OUT_DIR ?? "dist",
);
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const requests = [];
let updateCore = false;
const updateProbe = `
self.addEventListener("message",event=>{
  if(event.data!=="OPENSESAME_CORE_UPDATE_PROBE"||!event.ports[0])return;
  event.ports[0].postMessage("updated-core");
});`;
const server = await serve(dist, base, null, {
  request: ({ rel, url }) => requests.push(`${rel}${url.search}`),
  serviceWorker: (source) =>
    updateCore ? Buffer.concat([source, Buffer.from(updateProbe)]) : source,
});
const origin = `http://localhost:${server.address().port}`;
const scope = `${origin}${base}`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  headless: true,
});

const waitForActive = (page, suffix) =>
  page.evaluate(
    async ({ scope, suffix }) => {
      const stop = Date.now() + 30_000;
      while (Date.now() < stop) {
        const registration =
          await navigator.serviceWorker.getRegistration(scope);
        if (
          registration?.active?.state === "activated" &&
          new URL(registration.active.scriptURL).pathname.endsWith(suffix) &&
          navigator.serviceWorker.controller !== null &&
          new URL(
            navigator.serviceWorker.controller.scriptURL,
          ).pathname.endsWith(suffix)
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`worker ${suffix} did not activate`);
    },
    { scope, suffix },
  );

try {
  const coreContext = await browser.newContext({ serviceWorkers: "allow" });
  const corePage = await coreContext.newPage();
  await corePage.goto(`${scope}about.html`);
  await corePage.evaluate(
    ({ scope }) =>
      navigator.serviceWorker.register(`${scope}sw.js`, {
        scope,
        type: "classic",
        updateViaCache: "none",
      }),
    { scope },
  );
  await waitForActive(corePage, "/sw.js");
  const coreCaches = await corePage.evaluate(() => caches.keys());
  assert.ok(
    coreCaches.some((name) => name.endsWith(":core-only")),
    "a direct sw.js registration must use the core-only cache variant",
  );
  await coreContext.close();

  const pushContext = await browser.newContext({ serviceWorkers: "allow" });
  const pushPage = await pushContext.newPage();
  await pushPage.goto(`${scope}about.html`);
  await pushPage.evaluate(
    ({ scope }) =>
      navigator.serviceWorker.register(`${scope}sw-push.js`, {
        scope,
        type: "classic",
        updateViaCache: "none",
      }),
    { scope },
  );
  await waitForActive(pushPage, "/sw-push.js");
  const pushCaches = await pushPage.evaluate(() => caches.keys());
  assert.ok(
    pushCaches.some((name) => name.endsWith(":push")),
    "the wrapper must set the push cache variant before importing core",
  );
  assert.ok(
    requests.some((request) => /^sw\.js\?sha256=[a-f0-9]{64}$/.test(request)),
    "the browser must request the source-hashed core import",
  );

  updateCore = true;
  await pushPage.evaluate(
    async ({ scope }) => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      if (!registration) throw new Error("push registration disappeared");
      await registration.update();
    },
    { scope },
  );
  const probe = await pushPage.evaluate(
    async ({ scope }) => {
      const stop = Date.now() + 30_000;
      while (Date.now() < stop) {
        const registration =
          await navigator.serviceWorker.getRegistration(scope);
        const active = registration?.active;
        if (active) {
          const answer = await new Promise((resolve) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => resolve(null), 250);
            channel.port1.onmessage = (event) => {
              clearTimeout(timer);
              resolve(event.data);
            };
            active.postMessage("OPENSESAME_CORE_UPDATE_PROBE", [channel.port2]);
          });
          if (answer !== null) return answer;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    },
    { scope },
  );
  assert.equal(
    probe,
    "updated-core",
    "a changed imported sw.js must activate even when sw-push.js is unchanged",
  );

  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const offlineShell = await pushPage.evaluate(
    async ({ scope }) => {
      const response = await fetch(`${scope}index.html`, { cache: "reload" });
      return { ok: response.ok, text: await response.text() };
    },
    { scope },
  );
  assert.ok(offlineShell.ok && offlineShell.text.includes("<html"));
  await pushContext.close();
  console.log(
    "PASS push worker reuses, updates and precaches through shared core",
  );
} finally {
  await browser.close();
  if (server.listening)
    await new Promise((resolve) => server.close(() => resolve()));
}
