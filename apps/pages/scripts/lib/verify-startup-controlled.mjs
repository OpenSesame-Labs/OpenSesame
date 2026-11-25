import assert from "node:assert/strict";

/** A returning device may already be controlled by the installed worker. */
export async function verifyControlledStartup(browser, href, dependencyPath) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await context.addInitScript(() => {
      const key = "__startup_worker_navigation_check";
      sessionStorage.setItem(
        key,
        String(Number(sessionStorage.getItem(key)) + 1),
      );
    });
    const page = await context.newPage();
    const setup = page.getByRole("button", {
      name: "Set up your own",
      exact: true,
    });
    await page.goto(href, { waitUntil: "commit" });
    await setup.waitFor({ timeout: 30_000 });
    // The first controller can navigate to establish isolation. Wait for the
    // controlled, isolated document before measuring the returning visit.
    await page.waitForFunction(
      () => crossOriginIsolated && Boolean(navigator.serviceWorker?.controller),
      null,
      { timeout: 30_000 },
    );
    await setup.waitFor({ timeout: 30_000 });
    // Force the worker to fetch this module even if the current plan cached it.
    await page.evaluate(async (path) => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname === path)
            await cache.delete(request);
        }
      }
    }, dependencyPath);
    const initial = await page.evaluate(() =>
      Number(sessionStorage.getItem("__startup_worker_navigation_check")),
    );
    let requests = 0;
    await context.route(`**${dependencyPath}`, (route) => {
      requests += 1;
      return requests === 1 ? route.fulfill({ status: 503 }) : route.continue();
    });
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(
      (count) =>
        Number(sessionStorage.getItem("__startup_worker_navigation_check")) >=
        count + 2,
      initial,
      { timeout: 30_000 },
    );
    await setup.waitFor({ timeout: 30_000 });
    assert.equal(
      requests,
      2,
      "a controlled page retries the failed dependency",
    );
    console.log(
      "PASS: a worker-controlled phone recovers from a failed eager module",
    );
  } finally {
    await context.close();
  }
}
