/**
 * The patches under patches/ are installed, not just declared. npm ignores
 * `patchedDependencies`, so each patch ships as a tarball the lockfile pins.
 * These checks are hermetic: the registry comparison is the `verify` command.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  MANIFEST,
  applyPatch,
  differingFiles,
  extract,
  fileMap,
  integrity,
  patchApplies,
  readJson,
  root,
} from "./patched-dependencies.mjs";

const manifest = readJson(MANIFEST);
const packageJson = readJson("package.json");
const lock = readJson("package-lock.json");
const vendored = Object.entries(manifest.vendored);
const work = mkdtempSync(join(tmpdir(), "opensesame-patched-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

function split(selector) {
  const at = selector.lastIndexOf("@");
  return { name: selector.slice(0, at), version: selector.slice(at + 1) };
}

/** Lockfile locations that install `name` at `version`. */
function installed({ name, version }) {
  return Object.entries(lock.packages)
    .filter(([key]) => key.endsWith(`node_modules/${name}`))
    .filter(([, entry]) => entry.version === version)
    .map(([key, entry]) => ({ key, entry }));
}

let unpacked = 0;
function unpack(entry) {
  unpacked += 1;
  return extract(join(root, entry.tarball), join(work, String(unpacked)));
}

test("every declared patch is vendored or recorded as having no target", () => {
  const declared = Object.keys(packageJson.patchedDependencies).sort();
  const accounted = [
    ...Object.keys(manifest.vendored),
    ...Object.keys(manifest.notInstalled),
  ].sort();
  assert.deepEqual(accounted, declared);
  for (const [selector, entry] of vendored) {
    assert.equal(packageJson.patchedDependencies[selector], entry.patch);
    assert.equal(existsSync(join(root, entry.patch)), true, entry.patch);
    assert.equal(existsSync(join(root, entry.tarball)), true, entry.tarball);
  }
});

test("a patch recorded as having no target really has none", () => {
  for (const selector of Object.keys(manifest.notInstalled)) {
    const { name } = split(selector);
    const copies = Object.keys(lock.packages).filter((key) =>
      key.endsWith(`node_modules/${name}`),
    );
    assert.deepEqual(copies, [], `${name} is installed: vendor its patch`);
  }
});

test("the lockfile installs every copy of a patched package from its tarball", () => {
  for (const [selector, entry] of vendored) {
    const copies = installed(split(selector));
    assert.ok(copies.length > 0, `${selector} is not in the lockfile`);
    for (const copy of copies) {
      assert.equal(copy.entry.resolved, `file:${entry.tarball}`, copy.key);
      assert.equal(
        copy.entry.integrity,
        integrity(join(root, entry.tarball)),
        copy.key,
      );
    }
  }
});

test("npm reaches each tarball through a root dependency and an override", () => {
  // A relative file: override is resolved against the dependent package, not
  // the project, so the root depends on the tarball and the override points
  // at that dependency with npm's `$name` reference.
  const overrides = Object.entries(packageJson.overrides);
  for (const [selector, entry] of vendored) {
    const { name } = split(selector);
    assert.equal(packageJson.devDependencies[name], `file:${entry.tarball}`);
    const rule = overrides.find(
      ([key]) => key === name || key.startsWith(`${name}@`),
    );
    assert.deepEqual(rule?.[1], `$${name}`, selector);
  }
});

test("each tarball contains its patch and nothing unpatched", () => {
  for (const [selector, entry] of vendored) {
    const source = unpack(entry);
    assert.equal(patchApplies(source, entry.patch, true), true, selector);
    assert.equal(patchApplies(source, entry.patch, false), false, selector);
  }
});

test("the installed copy of each patched package equals its tarball", () => {
  for (const [selector, entry] of vendored) {
    const expected = fileMap(unpack(entry));
    for (const copy of installed(split(selector))) {
      const directory = join(root, copy.key);
      assert.equal(existsSync(directory), true, `${copy.key} is not installed`);
      assert.deepEqual(differingFiles(expected, fileMap(directory)), []);
    }
  }
});

test("the checks reject a published, unpatched package and name what differs", () => {
  for (const [selector, entry] of vendored) {
    const patched = fileMap(unpack(entry));
    const source = unpack(entry);
    // Removing the patch yields the published package.
    applyPatch(source, entry.patch, true);
    assert.equal(patchApplies(source, entry.patch, true), false, selector);
    assert.equal(patchApplies(source, entry.patch, false), true, selector);
    assert.ok(differingFiles(patched, fileMap(source)).length > 0, selector);
  }
  assert.deepEqual(
    differingFiles({ "a.js": "1", "b.js": "2" }, { "a.js": "1", "b.js": "3" }),
    ["b.js"],
  );
  assert.deepEqual(differingFiles({ "a.js": "1" }, {}), ["a.js"]);
});

test("a tarball with anything npm would install outside package/ is refused", () => {
  // npm strips the first path component of every entry, so an extra
  // top-level directory or a link would install files the comparison of
  // package/ never sees.
  const [, entry] = vendored[0];
  const tamper = (name, change) => {
    const source = join(work, `tamper-${name}`);
    mkdirSync(source);
    execFileSync("tar", ["-xzf", join(root, entry.tarball), "-C", source]);
    const members = change(source);
    const tarball = join(work, `${name}.tgz`);
    execFileSync("tar", ["-czf", tarball, "-C", source, ...members]);
    return tarball;
  };
  const extra = tamper("extra", (source) => {
    mkdirSync(join(source, "x", "esm"), { recursive: true });
    writeFileSync(join(source, "x", "esm", "index.js"), "export const x = 1;");
    return ["package", "x"];
  });
  const linked = tamper("linked", (source) => {
    symlinkSync("/etc/hostname", join(source, "package", "linked.js"));
    return ["package"];
  });
  const climbing = tamper("climbing", (source) => {
    writeFileSync(join(source, "outside.js"), "export const x = 1;");
    return ["package", "package/../outside.js"];
  });
  for (const tarball of [extra, linked, climbing])
    assert.throws(
      () => extract(tarball, join(work, "refused")),
      /refused entry/,
      tarball,
    );
  // The committed tarballs themselves pass.
  for (const [, each] of vendored) unpack(each);
});

test("the sprintf-js chain the js-yaml patch removes is gone from the lockfile", () => {
  const names = Object.keys(lock.packages);
  assert.deepEqual(
    names.filter((key) => key.endsWith("node_modules/sprintf-js")),
    [],
  );
  for (const key of names.filter((k) => k.endsWith("node_modules/argparse")))
    assert.equal(lock.packages[key].version, "2.0.1", key);
});

test("installed tiny-cbor encodes a text string by its byte length", async () => {
  // The published 0.2.11 wrote the UTF-16 length, which truncates any string
  // with a multi-byte character when it is decoded.
  const text = "héllo 日本";
  const bytes = new TextEncoder().encode(text).length;
  const directory = join(root, "node_modules/@levischuck/tiny-cbor");
  const builds = [
    createRequire(import.meta.url)(directory),
    await import(pathToFileURL(join(directory, "esm/index.js")).href),
  ];
  for (const { encodeCBOR, decodeCBOR } of builds) {
    const encoded = encodeCBOR(text);
    assert.equal(encoded[0], 0x60 + bytes);
    assert.equal(encoded.length, 1 + bytes);
    assert.equal(decodeCBOR(encoded), text);
  }
});
