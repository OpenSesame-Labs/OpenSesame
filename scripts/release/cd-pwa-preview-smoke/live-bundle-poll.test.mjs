import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listStagedShellAssetPaths,
  pollLiveShellAssets,
  shellAssetRefs,
  shellAssetRelative,
} from "./live-bundle-poll.mjs";
import { cdnPollBudget, sharedCdnDeadlineEndMs } from "./retry-budget.mjs";

const pagesBase = "https://example.github.io/OpenSesame/";

function manualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

function stageDist() {
  const root = mkdtempSync(join(tmpdir(), "pwa-shell-poll-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "assets", "preload.js"), "export const pre = 1;\n");
  writeFileSync(join(dist, "assets", "app.css"), "body{color:CanvasText}\n");
  writeFileSync(
    join(dist, "assets", "main.js"),
    "export const ready = true;\n",
  );
  writeFileSync(join(dist, "boot.js"), "window.__boot = true;\n");
  writeFileSync(
    join(dist, "index.html"),
    [
      "<!doctype html><html><head>",
      '<link rel="stylesheet" href="/OpenSesame/assets/app.css">',
      '<link rel="modulepreload" crossorigin href="/OpenSesame/assets/preload.js">',
      '<script type="module" crossorigin src="/OpenSesame/assets/main.js?release=1"></script>',
      '<script src="/OpenSesame/boot.js"></script>',
      '<link rel="modulepreload" href="/OpenSesame/assets/preload.js">',
      '<script src="https://cdn.example/remote.js"></script>',
      "</head><body></body></html>",
    ].join(""),
  );
  return { root, dist };
}

function envFor(dist, extra = {}) {
  return {
    PAGES_URL: pagesBase,
    STAGED_DIST: dist,
    ...extra,
  };
}

function hrefOf(url) {
  return url instanceof URL ? url.href : String(url);
}

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

test("shellAssetRefs ignores data-src and reads tags past > inside quotes", () => {
  const html = [
    '<div data-src="/OpenSesame/assets/ghost.js">',
    '<script type="module" src="/OpenSesame/assets/real.js" title="a>b">',
    '<link rel="stylesheet" data-href="/OpenSesame/assets/fake.css" href="/OpenSesame/assets/app.css">',
    "</script>",
  ].join("");
  assert.deepEqual(shellAssetRefs(html), [
    "/OpenSesame/assets/real.js",
    "/OpenSesame/assets/app.css",
  ]);
});

test("shellAssetRelative strips query from absolute same-origin URLs", () => {
  const base = "https://example.github.io/OpenSesame/";
  assert.equal(
    shellAssetRelative(
      "https://example.github.io/OpenSesame/assets/main.js?release=abc",
      base,
    ),
    "assets/main.js",
  );
});

test("pollLiveShellAssets does not refetch assets that already matched", async () => {
  const { root, dist } = stageDist();
  const counts = new Map();
  const clock = manualClock();
  try {
    writeFileSync(
      join(dist, "index.html"),
      [
        '<script src="/OpenSesame/assets/app.css"></script>',
        '<script src="/OpenSesame/assets/preload.js"></script>',
        '<script src="/OpenSesame/assets/main.js"></script>',
      ].join(""),
    );
    writeFileSync(join(dist, "assets", "app.css"), "a");
    writeFileSync(join(dist, "assets", "preload.js"), "b");
    writeFileSync(join(dist, "assets", "main.js"), "c");
    await assert.rejects(
      () =>
        pollLiveShellAssets(envFor(dist, { PWA_SMOKE_CDN_POLL_MS: "5" }), {
          fetch: async (url) => {
            const href = hrefOf(url);
            const key = href.split("/").pop();
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (key === "main.js") return new Response("stale");
            return new Response(readFileSync(join(dist, "assets", key)));
          },
          sleep: clock.sleep,
          now: clock.now,
        }),
      /assets\/main\.js/,
    );
    assert.equal(counts.get("app.css"), 1);
    assert.equal(counts.get("preload.js"), 1);
    assert.ok((counts.get("main.js") ?? 0) >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets honours shared CDN deadline between assets", async () => {
  const { root, dist } = stageDist();
  const clock = manualClock();
  try {
    writeFileSync(
      join(dist, "index.html"),
      [
        '<script src="/OpenSesame/assets/slow-a.js"></script>',
        '<script src="/OpenSesame/assets/slow-b.js"></script>',
      ].join(""),
    );
    writeFileSync(join(dist, "assets", "slow-a.js"), "a");
    writeFileSync(join(dist, "assets", "slow-b.js"), "b");
    let slowBAttempts = 0;
    await assert.rejects(
      () =>
        pollLiveShellAssets(
          envFor(dist, {
            PWA_SMOKE_CDN_STARTED_MS: "0",
            PWA_SMOKE_CDN_DEADLINE_MS: "10",
            PWA_SMOKE_CDN_POLL_MS: "5",
          }),
          {
            fetch: async (url) => {
              const href = hrefOf(url);
              if (href.endsWith("slow-a.js")) {
                await clock.sleep(11);
                return new Response(
                  readFileSync(join(dist, "assets/slow-a.js")),
                );
              }
              if (href.endsWith("slow-b.js")) {
                slowBAttempts += 1;
                return new Response("stale");
              }
              return new Response("stale");
            },
            sleep: clock.sleep,
            now: clock.now,
          },
        ),
      /CDN poll deadline expired/,
    );
    assert.ok(slowBAttempts <= 1);
    assert.ok(clock.now() >= 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared CDN deadline end is one window from PWA_SMOKE_CDN_STARTED_MS", () => {
  assert.equal(
    sharedCdnDeadlineEndMs({ PWA_SMOKE_CDN_STARTED_MS: "1000" }, 5000),
    121_000,
  );
});

test("pollLiveShellAssets rejects oversize Content-Length without reading the body", async () => {
  const { root, dist } = stageDist();
  let read = false;
  try {
    writeFileSync(
      join(dist, "index.html"),
      '<script src="/OpenSesame/assets/main.js"></script>',
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
              read = true;
              return new Response("x", {
                status: 200,
                headers: { "content-length": String(20 * 1024 * 1024) },
              });
            },
          },
        ),
      /body exceeds/,
    );
    assert.equal(read, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
