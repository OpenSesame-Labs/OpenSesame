import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { isString } from "../lib/json-boundary.mjs";

const root = resolve(import.meta.dirname, "../..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageAt = (path) => lock.packages[path];

test("glob 13 ranges resolve to published glob 14 and leave four patched tuples", () => {
  assert.equal(manifest.overrides["glob@^13.0.1"], "14.0.6");
  assert.equal(manifest.overrides["glob@^13.0.6"], "14.0.6");
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
  assert.equal(
    packageAt("node_modules/glob/node_modules/minimatch").version,
    "11.0.9",
  );
  for (const path of [
    "node_modules/promptfoo/node_modules/glob",
    "node_modules/@joshwooding/vite-plugin-react-docgen-typescript/node_modules/glob",
    "node_modules/@modelcontextprotocol/server-filesystem/node_modules/glob",
  ])
    assert.equal(packageAt(path), undefined, path);
  const patched = [
    [
      "node_modules/glob10-patched",
      "10.5.0",
      "file:patches/vendor/glob-10.5.0.tgz",
    ],
    [
      "node_modules/glob11-patched",
      "11.1.0",
      "file:patches/vendor/glob-11.1.0.tgz",
    ],
    [
      "node_modules/minimatch9-patched",
      "9.0.9",
      "file:patches/vendor/minimatch-9.0.9.tgz",
    ],
    [
      "node_modules/minimatch11-patched",
      "11.0.9",
      "file:patches/vendor/minimatch-11.0.9.tgz",
    ],
  ];
  for (const [path, version, resolved] of patched) {
    const entry = packageAt(path);
    assert.equal(entry.version, version, path);
    assert.equal(entry.resolved, resolved, path);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    const marker = "node_modules/";
    const at = path.lastIndexOf(marker);
    const name = isString(entry?.name)
      ? entry.name
      : at === -1
        ? undefined
        : path.slice(at + marker.length);
    if (name === "glob")
      assert.equal(String(entry.version).startsWith("13."), false, path);
  }
});
