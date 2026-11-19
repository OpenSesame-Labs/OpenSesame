import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  envFor,
  hrefOf,
  manualClock,
  pagesBase,
  stageDist,
} from "./live-bundle-poll.harness.mjs";
import {
  dynamicImportRefsFromJs,
  listStagedShellAssetPaths,
  pollLiveShellAssets,
  shellAssetRefs,
  shellAssetRelative,
} from "./live-bundle-poll.mjs";
import { sharedCdnDeadlineEndMs } from "./retry-budget.mjs";

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

test("listStagedShellAssetPaths follows dynamic import() from the entry chunk", () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(join(dist, "assets", "app-root.js"), "export const x = 1;\n");
    writeFileSync(
      join(dist, "assets", "main.js"),
      'export async function boot(){await import("./app-root.js");}\n',
    );
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    assert.deepEqual(listStagedShellAssetPaths(dist, pagesBase), [
      join(dist, "assets/main.js"),
      join(dist, "assets/app-root.js"),
    ]);
    assert.deepEqual(
      dynamicImportRefsFromJs(
        readFileSync(join(dist, "assets/main.js"), "utf8"),
      ),
      ["./app-root.js"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
