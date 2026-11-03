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
import { cdnRetryBudget, registryRetryBudget } from "./retry-budget.mjs";

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
  assert.equal(budget.attempts, 61);
});
