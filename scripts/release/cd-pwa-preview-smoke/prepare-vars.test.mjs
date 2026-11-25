import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildHurlVariables,
  normalizePagesBase,
  serializeHurlVariables,
} from "./prepare-vars.mjs";
import {
  cdnPollBudget,
  cdnRetryBudget,
  fetchAbortTimeoutMs,
  hurlMaxTimeArg,
  registryRetryBudget,
  sharedCdnDeadlineEndMs,
} from "./retry-budget.mjs";

const sha = "c".repeat(40);
const version = "0.0.0-alpha.12";

function stageDist(root) {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, "release.json"),
    `${JSON.stringify({
      format: "opensesame-pages-release",
      version: 1,
      revision: sha,
      sha256: {
        "index.html": "aa".repeat(32),
        "os-runtime-config.json": "bb".repeat(32),
      },
    })}\n`,
  );
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  writeFileSync(join(dist, "os-runtime-config.json"), "{}");
  writeFileSync(
    join(dist, "manifest.webmanifest"),
    `${JSON.stringify({ name: "OpenSesame", start_url: "/OpenSesame/" })}\n`,
  );
  writeFileSync(
    join(dist, "sw.js"),
    `${"self.addEventListener('install', () => {});\n".repeat(4)}`,
  );
  return dist;
}

test("normalizePagesBase requires trailing slash on HTTPS Pages URL", () => {
  assert.equal(
    normalizePagesBase("https://example.github.io/OpenSesame"),
    "https://example.github.io/OpenSesame/",
  );
});

test("buildHurlVariables reads stamped release digests and local PWA assets", () => {
  const root = mkdtempSync(join(tmpdir(), "pwa-hurl-vars-"));
  const dist = stageDist(root);
  const vars = buildHurlVariables({
    PAGES_URL: "https://example.github.io/OpenSesame/",
    GITHUB_SHA: sha,
    EXPECTED_VERSION: version,
    STAGED_DIST: dist,
  });
  assert.equal(vars.github_sha, sha);
  assert.equal(vars.expected_version, version);
  assert.equal(vars.sha256_index, "aa".repeat(32));
  assert.equal(vars.sha256_os_runtime, "bb".repeat(32));
  assert.match(vars.sha256_manifest, /^[a-f0-9]{64}$/);
  assert.match(vars.sha256_sw, /^[a-f0-9]{64}$/);
});

test("serializeHurlVariables uses Hurl properties syntax not JSON", () => {
  const text = serializeHurlVariables({
    pages_base: "https://example.github.io/OpenSesame/",
    github_sha: sha,
    expected_version: version,
    sha256_index: "aa".repeat(32),
  });
  assert.match(text, /^pages_base=https:\/\//m);
  assert.doesNotMatch(text, /^\{/m);
});

test("registry retry is a single attempt when publish already confirmed", () => {
  const budget = registryRetryBudget({ CD_REGISTRY_VERSION_CONFIRMED: "1" });
  assert.equal(budget.attempts, 0);
});

test("cdn retry budget stays bounded", () => {
  const budget = cdnRetryBudget({});
  assert.equal(budget.intervalMs, 2_000);
  assert.ok(budget.maxTimeMs > 1_000, "max-time must not collapse to 1s");
  const attempts = budget.retries + 1;
  assert.ok(
    attempts * budget.maxTimeMs + budget.retries * budget.intervalMs <= 120_000,
  );
});

test("cdn poll budget rejects non-safe deadline integers", () => {
  assert.throws(
    () => cdnPollBudget({ PWA_SMOKE_CDN_DEADLINE_MS: "9".repeat(400) }),
    /safe integer/,
  );
});

test("cdn retry budget caps retries inside the hurl wall clock", () => {
  const deadlineMs = Number.MAX_SAFE_INTEGER;
  const budget = cdnRetryBudget({
    PWA_SMOKE_CDN_DEADLINE_MS: String(deadlineMs),
    PWA_SMOKE_CDN_POLL_MS: "1",
  });
  assert.ok(budget.retries <= 10_000);
  assert.ok(budget.retries >= 0);
  const attempts = budget.retries + 1;
  assert.ok(
    attempts * budget.maxTimeMs + budget.retries * budget.intervalMs <=
      deadlineMs,
  );
});

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
