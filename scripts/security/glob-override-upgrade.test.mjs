import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { isString } from "../lib/json-boundary.mjs";

const root = resolve(import.meta.dirname, "../..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageAt = (path) => lock.packages[path];

function lockEntries(name) {
  const marker = "node_modules/";
  return Object.entries(lock.packages).filter(([path, entry]) => {
    const at = path.lastIndexOf(marker);
    const entryName = isString(entry?.name)
      ? entry.name
      : at === -1
        ? undefined
        : path.slice(at + marker.length);
    return entryName === name;
  });
}

function version(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  assert.ok(match, `unexpected version ${value}`);
  return match.slice(1).map(Number);
}

function compare(left, right) {
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function within(value, lowest, highest) {
  const parsed = version(value);
  return (
    compare(parsed, version(lowest)) >= 0 &&
    compare(parsed, version(highest)) <= 0
  );
}

test("every glob range resolves to the published glob 14 release", () => {
  for (const range of [
    "glob@^10.0.0",
    "glob@^11.0.1",
    "glob@^13.0.1",
    "glob@^13.0.6",
  ])
    assert.equal(manifest.overrides[range], "14.0.6", range);
  assert.equal(manifest.overrides.promptfoo.glob, "14.0.6");
  assert.equal(
    manifest.overrides["@joshwooding/vite-plugin-react-docgen-typescript"].glob,
    "14.0.6",
  );
  assert.equal(
    manifest.overrides["@modelcontextprotocol/server-filesystem"].glob,
    "14.0.6",
  );
  const published = packageAt("node_modules/glob");
  assert.equal(published.version, "14.0.6");
  assert.equal(
    published.resolved,
    "https://registry.npmjs.org/glob/-/glob-14.0.6.tgz",
  );
  assert.equal(
    published.integrity,
    "sha512-OwXjVP2svY5EyLY75Vek96C8qK43gqrt4xsZ+qSILdnaEiJPXkd62mcfUSNx/TQErQRdu5uM5kF67sfONragKw==",
  );
  for (const owner of [
    "archiver-utils",
    "workbox-build",
    "promptfoo",
    "@joshwooding/vite-plugin-react-docgen-typescript",
    "@modelcontextprotocol/server-filesystem",
  ]) {
    assert.equal(
      packageAt(`node_modules/${owner}/node_modules/glob`),
      undefined,
      owner,
    );
    assert.equal(
      packageAt(`node_modules/${owner}/node_modules/minimatch`)?.version ??
        "11.0.9",
      "11.0.9",
      owner,
    );
  }
});

test("no glob or minimatch copy is inside the GHSA-3g3m or GHSA-g3hv ranges", () => {
  const globs = lockEntries("glob");
  const minimatches = lockEntries("minimatch");
  assert.ok(globs.length > 0 && minimatches.length > 0);
  for (const [path, entry] of globs)
    assert.equal(within(entry.version, "9.0.0", "14.0.1"), false, path);
  for (const [path, entry] of minimatches)
    assert.equal(within(entry.version, "7.0.0", "11.0.0"), false, path);
});

test("the glob and minimatch backport aliases are gone", () => {
  for (const alias of ["glob10-patched", "glob11-patched", "minimatch9-patched"]) {
    assert.equal(manifest.devDependencies[alias], undefined, alias);
    assert.equal(packageAt(`node_modules/${alias}`), undefined, alias);
  }
  for (const key of ["archiver-utils", "workbox-build", "minimatch@^9.0.4"])
    assert.equal(manifest.overrides[key], undefined, key);
  for (const tuple of ["glob@10.5.0", "glob@11.1.0", "minimatch@9.0.9"])
    assert.equal(manifest.patchedDependencies[tuple], undefined, tuple);
  const alias = packageAt("node_modules/minimatch11-patched");
  assert.equal(alias.version, "11.0.9");
  assert.equal(alias.resolved, "file:patches/vendor/minimatch-11.0.9.tgz");
});
