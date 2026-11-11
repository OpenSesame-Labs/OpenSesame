import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** Lockfile entries that describe a workspace or the root, not an install. */
function manifests(lock) {
  return Object.entries(lock.packages).filter(
    ([key, entry]) => !key.includes("node_modules/") && !entry.link,
  );
}

/** Where one workspace's lockfile entry and its manifest disagree. */
function entryDrift(directory, entry, manifest) {
  const found = [];
  const where = directory || ".";
  // npm writes the manifest's own name and version into its installed
  // lockfile, so a stale one here fails the bootstrap the same way.
  const identity = directory === "" ? [] : ["name", "version"];
  for (const key of identity)
    if (entry[key] !== manifest[key])
      found.push(
        `${where} ${key}: manifest ${manifest[key] ?? "absent"}, lockfile ${entry[key] ?? "absent"}`,
      );
  for (const field of FIELDS) {
    const locked = entry[field] ?? {};
    const declared = manifest[field] ?? {};
    const names = new Set([...Object.keys(locked), ...Object.keys(declared)]);
    for (const name of names)
      if (locked[name] !== declared[name])
        found.push(
          `${where} ${field}.${name}: manifest ${declared[name] ?? "absent"}, lockfile ${locked[name] ?? "absent"}`,
        );
  }
  return found;
}

/** Everything the lockfile records differently from the manifests. */
function drift(lock, readManifest) {
  return manifests(lock).flatMap(([directory, entry]) => {
    const manifest = readManifest(directory);
    return manifest
      ? entryDrift(directory, entry, manifest)
      : [`${directory || "."}: locked but has no package.json`];
  });
}

test("the lockfile records each workspace's dependency ranges as its manifest declares them", () => {
  // `npm ci` accepts a lockfile whose recorded range differs from the manifest
  // as long as the locked version still satisfies it. The bootstrap script then
  // refuses the install, because what npm wrote no longer equals the lockfile.
  const found = drift(readJson("package-lock.json"), (directory) => {
    const path = join(directory, "package.json");
    return existsSync(join(root, path)) ? readJson(path) : undefined;
  });
  assert.deepEqual(found, []);
});

test("a changed range, an added or dropped dependency and a missing manifest are each reported", () => {
  const lock = {
    packages: {
      "": { dependencies: { a: "1.0.0" } },
      "packages/x": {
        name: "x",
        version: "1.0.0",
        dependencies: { b: "^2.0.0" },
        devDependencies: { c: "3" },
      },
      "packages/gone": {},
      "node_modules/b": { version: "2.0.0" },
      "node_modules/@scope/x": { resolved: "packages/x", link: true },
    },
  };
  const tree = {
    "": { dependencies: { a: "1.0.0" } },
    "packages/x": {
      name: "x",
      version: "1.0.1",
      dependencies: { b: "2.0.0", d: "4" },
    },
  };
  assert.deepEqual(
    drift(lock, (directory) => tree[directory]),
    [
      "packages/x version: manifest 1.0.1, lockfile 1.0.0",
      "packages/x dependencies.b: manifest 2.0.0, lockfile ^2.0.0",
      "packages/x dependencies.d: manifest 4, lockfile absent",
      "packages/x devDependencies.c: manifest absent, lockfile 3",
      "packages/gone: locked but has no package.json",
    ],
  );
  assert.deepEqual(
    drift({ packages: { "": tree[""] } }, () => tree[""]),
    [],
  );
});
