import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
      /runner .* (differs from committed HEAD|is not a regular file)/i,
    );
    assert.deepEqual(f.commands(), []);
  }
});

test("forged timestamp bytecode cannot replace verified projection helpers", (t) => {
  for (const helperPath of [
    "scripts/security/cargo-workspace-projection.py",
    "scripts/security/cargo-lock-projection.py",
  ]) {
    const f = setup(t);
    f.write(".git/info/exclude", "__pycache__/\n");
    f.write(
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/root", "crates/lib"]\n[workspace.dependencies]\nserde = { version = "1", features = ["derive"] }\n',
    );
    f.commit();
    const forge = `import importlib.util,marshal,pathlib,struct,sys
p=pathlib.Path(sys.argv[1]); s=p.stat()
c=pathlib.Path(importlib.util.cache_from_source(str(p))); c.parent.mkdir(exist_ok=True)
h=importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(s.st_mtime)&0xffffffff,s.st_size&0xffffffff)
c.write_bytes(h+marshal.dumps(compile('raise SystemExit(71)',str(p),'exec')))
spec=importlib.util.spec_from_file_location('probe',p)
spec.loader.exec_module(importlib.util.module_from_spec(spec))`;
    const probe = spawnSync(
      "python3",
      ["-I", "-B", "-c", forge, join(f.repo, helperPath)],
      {
        encoding: "utf8",
      },
    );
    assert.equal(probe.status, 71, probe.stderr);
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.commands(), ["run verify:a"]);
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

// Alters one reviewed Cargo target or helper per case; Cargo must never run.
const targetDriftDriver = String.raw`import hashlib, importlib._bootstrap_external, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1])
cases = [
    ("authority", "spec/formal/authority/Cargo.toml", "bin", "reviewed Cargo bin target"),
    ("authority", "spec/formal/authority/Cargo.toml", "build", "build script"),
    ("spiffe", "crates/spiffe-source/Cargo.toml", "lib", "reviewed Cargo lib target"),
    ("spiffe", "crates/spiffe-source/Cargo.toml", "test:outage_policy", "reviewed Cargo test target"),
    ("spiffe", "crates/spiffe-source/Cargo.toml", "custom", "build script"),
    ("source-lifetime", "crates/transport-security/Cargo.toml", "lib", "reviewed Cargo lib target"),
    ("source-lifetime", "crates/transport-security/Cargo.toml", "test:source_lifetime_formal", "reviewed Cargo test target"),
    ("source-lifetime", "crates/transport-security/Cargo.toml", "build", "build script"),
    ("source-lifetime", "crates/transport-security/Cargo.toml", "ambiguous", "ambiguous implicit Cargo test target"),
    ("source-trust-selection", "crates/gateway/Cargo.toml", "lib-default", "reviewed Cargo lib target"),
    ("source-trust-selection", "crates/gateway/Cargo.toml", "inactive", None),
    ("spiffe-peer-domain", "crates/ingress-evidence/Cargo.toml", "test:verify", "reviewed Cargo test target"),
]
for suite, helpers in [("authority", ("cargo-lock-projection.py", "cargo-workspace-projection.py")),
                       ("spiffe", ("cargo-lock-projection.py",)), ("source-lifetime", ("cargo-lock-projection.py",))]:
    for helper in helpers:
        for mode, expected in (("helper-source", "source drift"), ("helper-pyc", None)):
            cases.append((suite, "scripts/security/" + helper, mode, expected))
# Each target is a git checkout borrowing this repository's objects (hermetic lineage).
git_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
def git_out(*args): return subprocess.check_output(["git", *args], env=git_env, text=True).strip()
objects = pathlib.Path(git_out("-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir")) / "objects"
main = git_out("-C", str(root), "rev-parse", "origin/main")
with tempfile.TemporaryDirectory(prefix="formal-target-drift-") as temporary:
    for index, (suite, manifest, mode, expected) in enumerate(cases):
        target = pathlib.Path(temporary) / str(index)
        coverage_name = "spec/formal/" + suite + "/coverage.json"
        coverage = json.loads((root / coverage_name).read_text())
        names = [entry["path"] for entry in coverage["sources"] + coverage["optional_sources"]]
        names += [coverage["reviewed_attestation"]] if "reviewed_attestation" in coverage else []
        names += ["Cargo.toml", "Cargo.lock", coverage_name, "spec/formal/" + suite + "/check-drift.py", "scripts/security/cargo-lock-projection.py",
                  "scripts/security/cargo-workspace-projection.py", "scripts/security/cargo-workspace-multipackage.py", "scripts/security/formal_coverage_drift.py",
                  *git_out("-C", str(root), "ls-files", "patches/vendor/sqlx-sqlite-0.9.0*", "patches/vendor/keepass-0.17.0*", "tests/fuzz/cargo/Cargo.*").splitlines()]
        for name in dict.fromkeys(names):
            source, destination = root / name, target / name
            if source.exists():
                assert not source.is_symlink() and source.is_file(), name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
        git_out("init", "-q", str(target))
        (target / ".git/objects/info/alternates").write_text(str(objects) + "\n")
        git_out("-C", str(target), "update-ref", "refs/remotes/origin/main", main)
        file = target / manifest
        original = file.read_text()
        if mode == "helper-source":
            file.write_text(original + '\nimport os\nopen(os.environ["CARGO_MARKER"], "w").write("executed")\n')
            before = after = None
        elif mode == "helper-pyc":
            cache = pathlib.Path(importlib.util.cache_from_source(str(file)))
            cache.parent.mkdir(parents=True, exist_ok=True)
            payload = compile('import os\nopen(os.environ["CARGO_MARKER"], "w").write("executed")\n', str(file), "exec")
            stat = file.stat()
            cache.write_bytes(importlib._bootstrap_external._code_to_timestamp_pyc(payload, int(stat.st_mtime), stat.st_size))
            before = after = None
        elif mode == "bin":
            before, after = 'path = "conformance.rs"', 'path = "other.rs"'
        elif mode == "lib":
            before, after = 'path = "src/lib.rs"', 'path = "src/other.rs"'
        elif mode == "custom":
            before, after = '[package]\n', '[package]\nbuild = "custom.rs"\n'
        elif mode == "lib-default":
            before, after = None, '\n[lib]\npath = "src/other.rs"\n'
        elif mode.startswith("test:"):
            before, after = None, '\n[[test]]\nname = "' + mode.split(":", 1)[1] + '"\npath = "tests/other.rs"\n'
        elif mode == "inactive":
            before, after = None, '\n[[test]]\nname = "unrelated_inactive"\npath = "tests/unrelated.rs"\n'
        else:
            before = after = None
        if after is not None:
            if before is None: changed = original + after
            else:
                assert original.count(before) == 1, (suite, mode)
                changed = original.replace(before, after, 1)
            file.write_text(changed)
            entry = next(entry for entry in coverage["sources"] if entry["path"] == manifest)
            entry["sha256"] = hashlib.sha256(file.read_bytes()).hexdigest()
            if "reviewed_blob" in entry: entry["reviewed_blob"] = git_out("-C", str(target), "hash-object", "-w", str(file))
        if mode == "build":
            script = file.parent / "build.rs"
            script.write_text('fn main() {}\n')
            for entry in coverage["optional_sources"]:
                if entry["path"] == script.relative_to(target).as_posix():
                    entry["sha256"] = hashlib.sha256(script.read_bytes()).hexdigest()
        if mode == "ambiguous":
            alternate = file.parent / "tests/source_lifetime_formal/main.rs"
            alternate.parent.mkdir(parents=True, exist_ok=True)
            alternate.write_text('// alternate\n')
        (target / coverage_name).write_text(json.dumps(coverage))
        if "reviewed_attestation" in coverage:
            (attestation := target / coverage["reviewed_attestation"]).write_text(json.dumps(json.loads(attestation.read_text()) | {"sources": coverage["sources"]}))
        fake = target / "fake-bin/cargo"
        fake.parent.mkdir()
        fake.write_text('#!/bin/sh\nprintf invoked > "$CARGO_MARKER"\nexit 0\n')
        fake.chmod(0o700)
        marker = target / "cargo-invoked"
        env = git_env | {"PATH": str(fake.parent) + os.pathsep + os.environ["PATH"], "CARGO_MARKER": str(marker)}
        result = subprocess.run([sys.executable, "-I", "spec/formal/" + suite + "/check-drift.py"], cwd=target, env=env, text=True, capture_output=True)
        assert not marker.exists(), (suite, mode, "Cargo executed")
        if expected is None: assert result.returncode == 0, (suite, mode, result.stderr)
        else: assert result.returncode != 0 and expected in result.stderr, (suite, mode, result.stdout, result.stderr)
`;

test("Rust proof drift checks verify Cargo targets and projection helpers before Cargo", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync("python3", ["-I", "-c", targetDriftDriver, root], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr);
});
