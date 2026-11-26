import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { smokeInstallLock } from "./cd-pwa-pages-workspace-install.mjs";

test("cd-pwa-pages-workspace-install runs Pages-only npm ci without install scripts", () => {
  const source = readFileSync(
    new URL("./cd-pwa-pages-workspace-install.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /npm",\s*\[\s*"ci",\s*"--ignore-scripts",\s*"--include-workspace-root",\s*"-w",\s*"@opensesame\/pages",?\s*\]/u,
  );
  assert.doesNotMatch(source, /sharp@/u);
});

test("smoke dependency uses the exact version, URL and integrity from the full lock", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const plan = smokeInstallLock(pkg, lock);
  const entry = lock.packages["node_modules/playwright-core"];
  assert.equal(plan.packageJson.dependencies["playwright-core"], entry.version);
  assert.equal(
    plan.packageLock.packages["node_modules/playwright-core"].integrity,
    entry.integrity,
  );
  assert.equal(
    plan.packageLock.packages["node_modules/playwright-core"].resolved,
    entry.resolved,
  );
});

test("smoke dependency refuses changed versions, unpinned integrity and missing graph entries", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const entry = lock.packages["node_modules/playwright-core"];
  for (const altered of [
    { ...entry, version: "0.0.0" },
    { ...entry, integrity: "sha512-invalid" },
    { ...entry, resolved: "http://example.test/unsafe.tgz" },
    { ...entry, dependencies: { unexpected: "1.0.0" } },
    undefined,
  ]) {
    const modified = {
      ...lock,
      packages: { ...lock.packages, "node_modules/playwright-core": altered },
    };
    assert.throws(
      () => smokeInstallLock(pkg, modified),
      /not a valid standalone package/,
    );
  }
});
