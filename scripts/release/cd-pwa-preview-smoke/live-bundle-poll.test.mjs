import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  listStagedShellAssetPaths,
  pollLiveShellAssets,
} from "./live-bundle-poll.mjs";
import {
  envFor,
  hrefOf,
  manualClock,
  pagesBase,
  stageDist,
} from "./live-bundle-poll.harness.mjs";
import { cdnPollBudget } from "./retry-budget.mjs";

test("cdn poll budget is the deadline form of the hurl retry window", () => {
  assert.deepEqual(cdnPollBudget({}), { deadlineMs: 120_000, pollMs: 2_000 });
});

test("listStagedShellAssetPaths keeps script, modulepreload, and stylesheet files under dist", () => {
  const { root, dist } = stageDist();
  try {
    assert.deepEqual(listStagedShellAssetPaths(dist, pagesBase), [
      join(dist, "assets/app.css"),
      join(dist, "assets/preload.js"),
      join(dist, "assets/main.js"),
      join(dist, "boot.js"),
    ]);
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="./assets/main.js"></script>',
    );
    assert.deepEqual(listStagedShellAssetPaths(dist, pagesBase), [
      join(dist, "assets/main.js"),
    ]);
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="https://example.github.io/OpenSesame/assets/main.js"></script>',
    );
    assert.deepEqual(
      listStagedShellAssetPaths(dist, "https://example.github.io/OpenSesame"),
      [join(dist, "assets/main.js")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listStagedShellAssetPaths rejects a root path outside the Pages base", () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(
      join(dist, "index.html"),
      '<script src="/elsewhere/assets/main.js"></script>',
    );
    assert.throws(
      () => listStagedShellAssetPaths(dist, pagesBase),
      /outside Pages base \/OpenSesame\//,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets retries until each live body matches the staged digest", async () => {
  const { root, dist } = stageDist();
  const calls = [];
  let preloadTries = 0;
  const clock = manualClock();
  try {
    const matched = await pollLiveShellAssets(envFor(dist), {
      fetch: async (url, init) => {
        const href = hrefOf(url);
        calls.push({ href, init });
        if (href.endsWith("/assets/app.css")) {
          return new Response(readFileSync(join(dist, "assets/app.css")));
        }
        if (href.endsWith("/assets/preload.js")) {
          preloadTries += 1;
          if (preloadTries === 1)
            return new Response("missing", { status: 404 });
          return new Response(readFileSync(join(dist, "assets/preload.js")));
        }
        if (href.endsWith("/assets/main.js")) {
          return new Response(readFileSync(join(dist, "assets/main.js")));
        }
        if (href.endsWith("/boot.js")) {
          return new Response(readFileSync(join(dist, "boot.js")));
        }
        throw new Error(`unexpected ${href}`);
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.deepEqual(matched, [
      "assets/app.css",
      "assets/preload.js",
      "assets/main.js",
      "boot.js",
    ]);
    assert.equal(preloadTries, 2);
    assert.equal(
      calls.filter((call) => call.href.endsWith("/assets/main.js")).length,
      1,
    );
    assert.equal(calls[0].href, `${pagesBase}assets/app.css`);
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(clock.now(), 2_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets names the first mismatched path when the deadline expires", async () => {
  const { root, dist } = stageDist();
  const clock = manualClock();
  const calls = [];
  try {
    await assert.rejects(
      () =>
        pollLiveShellAssets(
          envFor(dist, {
            PWA_SMOKE_CDN_DEADLINE_MS: "20",
            PWA_SMOKE_CDN_POLL_MS: "10",
          }),
          {
            fetch: async (url) => {
              calls.push(hrefOf(url));
              return new Response("stale", { status: 200 });
            },
            sleep: clock.sleep,
            now: clock.now,
          },
        ),
      /live shell asset mismatch: assets\/app\.css \((?:sha256|CDN poll deadline expired)/,
    );
    assert.deepEqual(calls, [
      `${pagesBase}assets/app.css`,
      `${pagesBase}assets/app.css`,
      `${pagesBase}assets/app.css`,
    ]);
    assert.equal(clock.now(), 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets does not retry a missing staged file", async () => {
  const { root, dist } = stageDist();
  let fetched = 0;
  try {
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/missing.js"></script>',
    );
    await assert.rejects(
      () =>
        pollLiveShellAssets(envFor(dist), {
          fetch: async () => {
            fetched += 1;
            return new Response("no");
          },
        }),
      /staged shell asset missing: assets\/missing\.js/,
    );
    assert.equal(fetched, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets drains a non-OK body before retrying", async () => {
  const { root, dist } = stageDist();
  const clock = manualClock();
  let bodyReleased = false;
  let preloadTries = 0;
  try {
    const matched = await pollLiveShellAssets(envFor(dist), {
      fetch: async (url) => {
        const href = hrefOf(url);
        if (href.endsWith("/assets/app.css")) {
          return new Response(readFileSync(join(dist, "assets/app.css")));
        }
        if (href.endsWith("/assets/preload.js")) {
          preloadTries += 1;
          if (preloadTries === 1) {
            const body = new ReadableStream({
              cancel() {
                bodyReleased = true;
              },
            });
            return new Response(body, { status: 404 });
          }
          return new Response(readFileSync(join(dist, "assets/preload.js")));
        }
        if (href.endsWith("/assets/main.js")) {
          return new Response(readFileSync(join(dist, "assets/main.js")));
        }
        if (href.endsWith("/boot.js")) {
          return new Response(readFileSync(join(dist, "boot.js")));
        }
        throw new Error(`unexpected ${href}`);
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.equal(bodyReleased, true);
    assert.equal(preloadTries, 2);
    assert.equal(matched.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets names the asset path when a body read stalls", async () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    await assert.rejects(
      () =>
        pollLiveShellAssets(
          envFor(dist, {
            PWA_SMOKE_CDN_DEADLINE_MS: "0",
            PWA_SMOKE_CDN_POLL_MS: "10",
          }),
          {
            fetch: async () =>
              new Response(
                new ReadableStream({
                  pull() {},
                }),
                { status: 200 },
              ),
            readTimeoutMs: 25,
          },
        ),
      /live shell asset mismatch: assets\/main\.js \(body read timed out\)/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets rejects an oversized live body by its path", async () => {
  const { root, dist } = stageDist();
  const chunk = new Uint8Array(1024 * 1024);
  try {
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    await assert.rejects(
      () =>
        pollLiveShellAssets(
          envFor(dist, {
            PWA_SMOKE_CDN_DEADLINE_MS: "0",
            PWA_SMOKE_CDN_POLL_MS: "10",
          }),
          {
            fetch: async () => {
              let sent = 0;
              const body = new ReadableStream({
                pull(controller) {
                  if (sent > 16 * 1024 * 1024) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(chunk);
                  sent += chunk.byteLength;
                },
              });
              return new Response(body, { status: 200 });
            },
          },
        ),
      /live shell asset mismatch: assets\/main\.js \(body exceeds 16777216 bytes\)/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});