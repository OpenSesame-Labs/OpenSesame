import assert from "node:assert/strict";
import { copyFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";
import { parseRegistry } from "./formal-proof-push-gate-registry.mjs";
import { sameProofContract } from "./formal-proof-required-suites.mjs";

const rootManifest = "crates/root/Cargo.toml";
const libManifest = "crates/lib/Cargo.toml";
const libBuild = "crates/lib/build.rs";
const helper = "scripts/security/formal-proof-manifest-set.mjs";
const rootPath = rootManifest;
const libPath = libManifest;
const ancestorPath = "crates/Cargo.toml";
const buildPaths = ["crates/root/build.rs", libBuild, "crates/future/build.rs"];

test("multi-package descriptors require mapped manifests and a matching lock contract", () => {
  const suite = {
    id: "a",
    implementation: [
      rootPath,
      libPath,
      ancestorPath,
      ...buildPaths.slice(0, 2),
    ],
    proofs: ["spec/formal/a/proof"],
    command: ["npm", "run", "verify:a"],
    lockProjection: { path: "Cargo.lock", root: "local-root" },
    manifestProjection: {
      path: "Cargo.toml",
      package: rootPath,
      lock: "Cargo.lock",
      root: "local-root",
      manifests: [rootPath, libPath],
    },
  };
  const parse = (value) =>
    parseRegistry(Buffer.from(JSON.stringify({ version: 1, suites: [value] })));
  assert.equal(parse(suite).suites.length, 1);
  for (const change of [
    { manifests: [] },
    { manifests: [rootPath, rootPath] },
    { manifests: [libPath] },
    { manifests: [rootPath, "crates/unmapped/Cargo.toml"] },
    { manifests: [rootPath, "../escape/Cargo.toml"] },
  ])
    assert.throws(
      () =>
        parse({
          ...suite,
          manifestProjection: { ...suite.manifestProjection, ...change },
        }),
      /Invalid formal proof suite/,
    );
  assert.throws(
    () => parse({ ...suite, lockProjection: undefined }),
    /Invalid formal proof suite/,
  );
  assert.throws(
    () =>
      parse({ ...suite, implementation: [rootPath, libPath, ...buildPaths] }),
    /Invalid formal proof suite/,
  );
  assert.throws(
    () =>
      parse({ ...suite, implementation: [rootPath, libPath, ancestorPath] }),
    /Invalid formal proof suite/,
  );
  assert.throws(
    () =>
      parse({
        ...suite,
        lockProjection: { path: "Cargo.lock", root: "other" },
      }),
    /Invalid formal proof suite/,
  );
  assert.throws(
    () =>
      parse({
        ...suite,
        lockProjection: {
          path: "Cargo.lock",
          root: "local-root",
          dependency: "local-lib",
        },
      }),
    /Invalid formal proof suite/,
  );
  const reversed = structuredClone(suite);
  reversed.manifestProjection.manifests.reverse();
  assert.equal(sameProofContract(suite, reversed), true);
  reversed.manifestProjection.manifests.pop();
  assert.equal(sameProofContract(suite, reversed), false);
  delete reversed.manifestProjection.manifests;
  assert.equal(sameProofContract(suite, reversed), false);
});

function setup(t) {
  const f = fixture(t);
  const policy = {
    version: 1,
    suites: [
      {
        id: "a",
        implementation: [
          "src/a",
          rootManifest,
          libManifest,
          "crates/Cargo.toml",
          "crates/root/build.rs",
          libBuild,
        ],
        proofs: ["spec/formal/a/proof"],
        command: ["npm", "run", "verify:a"],
        lockProjection: { path: "Cargo.lock", root: "local-root" },
        manifestProjection: {
          path: "Cargo.toml",
          lock: "Cargo.lock",
          root: "local-root",
          package: rootManifest,
          manifests: [rootManifest, libManifest],
        },
      },
    ],
  };
  f.pin(policy);
  for (const path of [
    "spec/formal/proof-registry.json",
    "spec/formal/proof-requirements.json",
  ])
    f.write(path, JSON.stringify(policy));
  f.write(
    "Cargo.toml",
    '[workspace]\nmembers = ["crates/root", "crates/lib"]\n[workspace.dependencies]\nserde = "1"\n',
  );
  f.write(
    rootManifest,
    '[package]\nname = "local-root"\nversion = "0.1.0"\n[dependencies]\nlocal-lib = { path = "../lib" }\n',
  );
  f.write(
    libManifest,
    '[package]\nname = "local-lib"\nversion = "0.1.0"\n[dependencies]\nserde.workspace = true\n',
  );
  f.write(
    "Cargo.lock",
    'version = 4\n[[package]]\nname = "local-root"\nversion = "0.1.0"\ndependencies = ["local-lib"]\n[[package]]\nname = "local-lib"\nversion = "0.1.0"\ndependencies = ["serde"]\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://example.invalid/index"\nchecksum = "' +
      "a".repeat(64) +
      '"\n',
  );
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  return f;
}

test("a dirty or symlinked manifest helper cannot hide a relevant workspace change", (t) => {
  for (const kind of ["dirty", "symlink"]) {
    const f = setup(t);
    f.write(
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/root", "crates/lib"]\n[workspace.dependencies]\nserde = { version = "1", features = ["derive"] }\n',
    );
    f.commit();
    const path = join(f.repo, helper);
    if (kind === "dirty") {
      const content = readFileSync(path, "utf8");
      const changed = content.replace(
        "const right = readBlob(after, descriptor.path);",
        "const right = readBlob(before, descriptor.path);",
      );
      assert.notEqual(changed, content);
      f.write(helper, changed);
    } else {
      const copy = join(f.dir, "helper-copy.mjs");
      copyFileSync(path, copy);
      rmSync(path);
      symlinkSync(copy, path);
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, `${kind}: ${result.stdout}`);
    assert.match(
      result.stderr,
      /helper (differs|is missing or not a regular file)/i,
    );
    assert.deepEqual(f.commands(), []);
  }
});

test("local build-script addition, removal, transient addition and symlink select the suite", (t) => {
  for (const kind of ["add", "remove", "transient", "symlink"]) {
    const f = setup(t);
    if (kind === "symlink") symlinkSync("other.rs", join(f.repo, libBuild));
    else
      f.write(
        libBuild,
        'fn main() { println!("cargo:rustc-cfg=custom_policy"); }\n',
      );
    f.commit();
    if (kind === "remove")
      f.git(
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/main",
      );
    if (kind === "transient" || kind === "remove") {
      rmSync(join(f.repo, libBuild));
      f.commit();
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    assert.deepEqual(f.commands(), ["run verify:a"], kind);
  }
});

test("custom build paths fail closed during historical projection", (t) => {
  for (const transient of [false, true]) {
    const f = setup(t);
    const original = readFileSync(join(f.repo, libManifest), "utf8");
    f.write(
      libManifest,
      original.replace(
        'version = "0.1.0"',
        'version = "0.1.0"\nbuild = "custom.rs"',
      ),
    );
    f.commit();
    if (transient) {
      f.write(libManifest, original);
      f.commit();
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /projection/i);
    assert.deepEqual(f.commands(), []);
  }
});
