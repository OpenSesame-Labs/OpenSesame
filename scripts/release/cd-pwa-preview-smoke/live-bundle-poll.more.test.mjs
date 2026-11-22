import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  cssUrlRefsFromStylesheet,
  dynamicImportRefsFromJs,
  listStagedShellAssetPaths,
  pollLiveShellAssets,
  readBoundedBody,
  shellAssetRefs,
  shellAssetRelative,
} from "./live-bundle-poll.mjs";
import {
  cdnRetryBudget,
  fetchAbortTimeoutMs,
  hurlMaxTimeArg,
  sharedCdnDeadlineEndMs,
} from "./retry-budget.mjs";

test("fetchAbortTimeoutMs caps stalled headers at the shared CDN remainder", () => {
  assert.equal(
    fetchAbortTimeoutMs(15_000, 100, () => 95),
    5,
  );
  assert.equal(
    fetchAbortTimeoutMs(15_000, 100, () => 50),
    50,
  );
  assert.equal(
    fetchAbortTimeoutMs(15_000, 50, () => 60),
    1,
  );
  assert.equal(
    fetchAbortTimeoutMs(15_000, 50, () => 60, false),
    15_000,
  );
  assert.equal(
    fetchAbortTimeoutMs(15_000, 200, () => 50, false),
    15_000,
  );
});

test("cdnRetryBudget keeps the default window off a one-second max-time", () => {
  const budget = cdnRetryBudget({});
  assert.deepEqual(budget, {
    retries: 6,
    intervalMs: 2_000,
    maxTimeMs: 15_000,
  });
  assert.ok(
    budget.maxTimeMs > 1_000,
    "per-attempt time must not collapse to 1s",
  );
});

test("cdnRetryBudget handles zero and sub-second deadlines without a 1s default", () => {
  assert.deepEqual(cdnRetryBudget({ PWA_SMOKE_CDN_DEADLINE_MS: "0" }), {
    retries: 0,
    intervalMs: 2_000,
    maxTimeMs: 15_000,
  });
  assert.deepEqual(cdnRetryBudget({ PWA_SMOKE_CDN_DEADLINE_MS: "1" }), {
    retries: 0,
    intervalMs: 2_000,
    maxTimeMs: 1,
  });
  assert.deepEqual(cdnRetryBudget({ PWA_SMOKE_CDN_DEADLINE_MS: "250" }), {
    retries: 0,
    intervalMs: 2_000,
    maxTimeMs: 250,
  });
  assert.deepEqual(
    cdnRetryBudget({
      PWA_SMOKE_CDN_DEADLINE_MS: "999",
      PWA_SMOKE_CDN_POLL_MS: "100",
    }),
    { retries: 0, intervalMs: 100, maxTimeMs: 999 },
  );
});

test("cdnRetryBudget fits one wall-clock window across edge deadlines", () => {
  const edges = [
    1, 250, 999, 1_000, 2_000, 15_000, 17_000, 20_000, 51_000, 120_000,
    1_800_000, 170_000_000,
  ];
  for (const deadlineMs of edges) {
    const { retries, intervalMs, maxTimeMs } = cdnRetryBudget({
      PWA_SMOKE_CDN_DEADLINE_MS: String(deadlineMs),
    });
    const worstCaseMs = (retries + 1) * maxTimeMs + retries * intervalMs;
    assert.ok(
      worstCaseMs <= deadlineMs,
      `deadline ${deadlineMs}ms: ${worstCaseMs}ms worst case must fit`,
    );
    assert.ok(maxTimeMs <= 15_000);
  }
  // 30 minutes fits exactly: 106 attempts × 15s + 105 waits × 2s.
  assert.deepEqual(cdnRetryBudget({ PWA_SMOKE_CDN_DEADLINE_MS: "1800000" }), {
    retries: 105,
    intervalMs: 2_000,
    maxTimeMs: 15_000,
  });
});

test("hurlMaxTimeArg emits a duration suffix so sub-second budgets parse", () => {
  assert.equal(hurlMaxTimeArg(15_000), "15000ms");
  assert.equal(hurlMaxTimeArg(250), "250ms");
  assert.equal(hurlMaxTimeArg(1), "1ms");
});

test("readBoundedBody stops at shared CDN deadline before per-chunk cap", async () => {
  const stream = new ReadableStream({ pull() {} });
  await assert.rejects(
    () =>
      readBoundedBody(
        new Response(stream),
        "assets/main.js",
        100,
        () => 99,
        5000,
      ),
    /body read timed out/,
  );
});

test("readBoundedBody rejects expired nonzero CDN deadline when enforced", async () => {
  await assert.rejects(
    () =>
      readBoundedBody(
        new Response("ok"),
        "assets/main.js",
        100,
        () => 101,
        5000,
        true,
      ),
    /CDN poll deadline expired/,
  );
});

test("readBoundedBody caps arrayBuffer reads at the CDN body deadline", async () => {
  const response = {
    body: null,
    headers: new Headers(),
    arrayBuffer: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(new TextEncoder().encode("x").buffer), 50);
      }),
  };
  await assert.rejects(
    () =>
      readBoundedBody(response, "assets/main.js", 100, () => 95, 5000, true),
    /body read timed out/,
  );
});

test("readBoundedBody keeps the per-chunk cap when the deadline is not enforced", async () => {
  const stream = new ReadableStream({ pull() {} });
  await assert.rejects(
    () =>
      readBoundedBody(
        new Response(stream),
        "assets/main.js",
        100,
        () => 101,
        20,
        false,
      ),
    /body read timed out/,
  );
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

test("dynamicImportRefsFromJs includes side-effect and minified export-from", () => {
  const source = 'import"./side.js";export{a}from"./peer.js";\n';
  assert.deepEqual(
    new Set(dynamicImportRefsFromJs(source)),
    new Set(["./side.js", "./peer.js"]),
  );
});

test("dynamicImportRefsFromJs finds newline-separated static imports", () => {
  const source = [
    'import { a } from "./one.js"',
    'import { b } from "./two.js"',
    'import "./three.css"',
    'export { c } from "./four.js"',
    "",
  ].join("\n");
  assert.deepEqual(
    new Set(dynamicImportRefsFromJs(source)),
    new Set(["./one.js", "./two.js", "./three.css", "./four.js"]),
  );
});

test("dynamicImportRefsFromJs allows whitespace after a separator", () => {
  const source = 'import"./a.js"; \n import"./b.js";\n\timport"./c.css"\n';
  assert.deepEqual(
    new Set(dynamicImportRefsFromJs(source)),
    new Set(["./a.js", "./b.js", "./c.css"]),
  );
});

test("dynamicImportRefsFromJs includes side-effect stylesheet imports", () => {
  const source = 'import"./async.css";\n';
  assert.deepEqual(dynamicImportRefsFromJs(source), ["./async.css"]);
});

test("cssUrlRefsFromStylesheet collects relative font and asset urls", () => {
  const css =
    "@font-face{font-family:mark;src:url(./fonts/os-logo.woff2)}.x{background:url(/OpenSesame/assets/bg.png)}";
  assert.deepEqual(cssUrlRefsFromStylesheet(css), [
    "./fonts/os-logo.woff2",
    "/OpenSesame/assets/bg.png",
  ]);
});

test("listStagedShellAssetPaths follows url() dependencies from shell CSS", () => {
  const { root, dist } = stageDist();
  try {
    mkdirSync(join(dist, "assets", "fonts"), { recursive: true });
    writeFileSync(join(dist, "assets", "fonts", "os-logo.woff2"), "font");
    writeFileSync(
      join(dist, "assets", "app.css"),
      '@font-face{src:url("./fonts/os-logo.woff2")}',
    );
    const paths = listStagedShellAssetPaths(dist, pagesBase).map((p) =>
      p.replace(`${dist}/`, ""),
    );
    assert.ok(paths.includes("assets/fonts/os-logo.woff2"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamicImportRefsFromJs keeps Vite assets/*.js literals dist-relative", () => {
  const source = 'const m={"assets/app-root.js":1};\n';
  assert.deepEqual(dynamicImportRefsFromJs(source), ["assets/app-root.js"]);
});

test("listStagedShellAssetPaths includes Vite dependency-table CSS for boot chunks", () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(
      join(dist, "assets", "app-root.css"),
      "body{color:CanvasText}\n",
    );
    writeFileSync(
      join(dist, "assets", "main.js"),
      'const __vite__mapDeps=()=>["assets/app-root.js","assets/app-root.css"];\n',
    );
    writeFileSync(join(dist, "assets", "app-root.js"), "export const x = 1;\n");
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    const paths = listStagedShellAssetPaths(dist, pagesBase).map((p) =>
      p.replace(`${dist}/`, ""),
    );
    assert.ok(paths.includes("assets/app-root.css"));
    assert.ok(paths.includes("assets/app-root.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listStagedShellAssetPaths includes Vite dependency-table assets under Pages base", () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(join(dist, "assets", "app-root.js"), "export const x = 1;\n");
    writeFileSync(
      join(dist, "assets", "main.js"),
      'const __vite__mapDeps=()=>["assets/app-root.js"];\n',
    );
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    assert.deepEqual(listStagedShellAssetPaths(dist, pagesBase), [
      join(dist, "assets/main.js"),
      join(dist, "assets/app-root.js"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listStagedShellAssetPaths follows static import from in the entry chunk", () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(join(dist, "assets", "child.js"), "export const c = 1;\n");
    writeFileSync(
      join(dist, "assets", "main.js"),
      'import { c } from "./child.js";\nexport const m = c;\n',
    );
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    assert.deepEqual(listStagedShellAssetPaths(dist, pagesBase), [
      join(dist, "assets/main.js"),
      join(dist, "assets/child.js"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listStagedShellAssetPaths follows consecutive newline-separated imports", () => {
  const { root, dist } = stageDist();
  try {
    writeFileSync(join(dist, "assets", "child-a.js"), "export const a = 1;\n");
    writeFileSync(join(dist, "assets", "child-b.js"), "export const b = 2;\n");
    writeFileSync(
      join(dist, "assets", "main.js"),
      'import { a } from "./child-a.js"\nimport { b } from "./child-b.js"\n',
    );
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/OpenSesame/assets/main.js"></script>',
    );
    assert.deepEqual(listStagedShellAssetPaths(dist, pagesBase), [
      join(dist, "assets/main.js"),
      join(dist, "assets/child-a.js"),
      join(dist, "assets/child-b.js"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    sharedCdnDeadlineEndMs({
      PWA_SMOKE_CDN_STARTED_MS: "1000",
      PWA_SMOKE_CDN_DEADLINE_MS: "120000",
    }),
    121_000,
  );
});

test("shared CDN deadline end rejects a window past MAX_SAFE_INTEGER", () => {
  assert.throws(
    () =>
      sharedCdnDeadlineEndMs({
        PWA_SMOKE_CDN_STARTED_MS: "9007199254740991",
        PWA_SMOKE_CDN_DEADLINE_MS: "120000",
      }),
    /MAX_SAFE_INTEGER/,
  );
  // The sum, not each input, decides: exactly MAX_SAFE_INTEGER still fits.
  assert.equal(
    sharedCdnDeadlineEndMs({
      PWA_SMOKE_CDN_STARTED_MS: "0",
      PWA_SMOKE_CDN_DEADLINE_MS: "9007199254740991",
    }),
    9_007_199_254_740_991,
  );
});

test("pollLiveShellAssets rejects a poll window that loses integer precision", async () => {
  const { root, dist } = stageDist();
  try {
    await assert.rejects(
      () =>
        pollLiveShellAssets(
          envFor(dist, { PWA_SMOKE_CDN_DEADLINE_MS: "9007199254740991" }),
          {
            fetch: async () => new Response("no"),
          },
        ),
      /MAX_SAFE_INTEGER/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pollLiveShellAssets rejects oversize Content-Length without consuming body bytes", async () => {
  const { root, dist } = stageDist();
  let pulls = 0;
  let readers = 0;
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
            // A plain response-like: undici's Response wrapper pumps its
            // own body copy in the background, which would hide whether
            // the poll itself ever acquired the stream.
            fetch: async () => {
              const body = new ReadableStream({
                pull(controller) {
                  // One pull only primes the stream's own queue; a
                  // consumer reading 20 MiB would pull repeatedly.
                  pulls += 1;
                  controller.enqueue(new Uint8Array(64 * 1024));
                },
              });
              const acquireReader = body.getReader.bind(body);
              body.getReader = () => {
                readers += 1;
                return acquireReader();
              };
              return {
                ok: true,
                status: 200,
                headers: new Headers({
                  "content-length": String(20 * 1024 * 1024),
                }),
                body,
              };
            },
          },
        ),
      /body exceeds 16777216 bytes/,
    );
    assert.equal(readers, 0);
    assert.ok(pulls <= 1, `stream was consumed: ${pulls} pulls`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
