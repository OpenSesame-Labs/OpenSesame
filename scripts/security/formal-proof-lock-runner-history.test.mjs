import assert from "node:assert/strict";
import {
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

const lock = ({ sdk = "a", unrelated = "c" } = {}) => `version = 4
[[package]]
name = "opensesame-spiffe-source"
version = "0.1.0"
dependencies = ["spiffe"]
[[package]]
name = "spiffe"
version = "0.19.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${sdk.repeat(64)}"
[[package]]
name = "unrelated"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${unrelated.repeat(64)}"
`;

function initialize(t) {
  const f = fixture(t);
  const policy = structuredClone(registry);
  policy.suites.push({
    id: "spiffe",
    implementation: ["src/spiffe"],
    lockProjection: { path: "Cargo.lock", root: "opensesame-spiffe-source" },
    proofs: ["spec/formal/spiffe/proof"],
    command: ["npm", "run", "verify:spiffe"],
  });
  f.pin(policy);
  f.write("spec/formal/proof-registry.json", JSON.stringify(policy));
  f.write("spec/formal/proof-requirements.json", JSON.stringify(policy));
  f.write("spec/formal/spiffe/proof", "proof\n");
  f.write("src/spiffe", "source\n");
  f.write("Cargo.lock", lock());
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  return { f, base: f.git("rev-parse", "HEAD") };
}

function expectPush(f, expected) {
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), expected ? ["run verify:spiffe"] : []);
}

test("committed projection runner tampering cannot suppress lock selection", (t) => {
  for (const kind of [
    "helper",
    "selector",
    "manifest-set",
    "unrelated-lock",
    "reverted",
    "other-head",
  ]) {
    const { f, base } = initialize(t);
    let path = "scripts/security/cargo-lock-projection.py";
    if (kind === "selector")
      path = "scripts/security/formal-proof-lock-history.mjs";
    if (kind === "manifest-set")
      path = "scripts/security/formal-proof-manifest-set.mjs";
    const original = readFileSync(join(f.repo, path), "utf8");
    f.write(
      "Cargo.lock",
      kind === "unrelated-lock" ? lock({ unrelated: "e" }) : lock({ sdk: "e" }),
    );
    if (kind === "other-head") {
      const target = f.commit();
      f.write(path, "print('{\"changed\":false}')\n");
      f.commit();
      const result = f.run(f.tuple(target, base));
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /projection.*changed/i, kind);
      assert.deepEqual(f.commands(), []);
      continue;
    }
    f.write(
      path,
      kind === "selector" || kind === "manifest-set"
        ? `${original}\n// changed selector\n`
        : "print('{\"changed\":false}')\n",
    );
    f.commit();
    if (kind === "reverted") {
      f.write(path, original);
      f.commit();
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /projection.*(changed|history)/i, kind);
    assert.deepEqual(f.commands(), []);
  }
});

test("a dirty, symlinked, or mode-changed projection selector fails closed", (t) => {
  for (const kind of ["changed", "symlink", "mode", "manifest-set"]) {
    const { f } = initialize(t);
    f.write("Cargo.lock", lock({ sdk: "e" }));
    f.commit();
    const path =
      kind === "manifest-set"
        ? "scripts/security/formal-proof-manifest-set.mjs"
        : "scripts/security/formal-proof-lock-history.mjs";
    const absolute = join(f.repo, path);
    const original = readFileSync(absolute, "utf8");
    if (kind === "changed") {
      const name =
        "export function lockAffectedSuites(root, change, history, head, git) {";
      assert.ok(original.includes(name));
      f.write(path, original.replace(name, `${name} return new Set();`));
    } else if (kind === "manifest-set")
      f.write(path, `${original}\n// dirty selector\n`);
    else if (kind === "symlink") {
      f.write("scripts/security/selector-copy.mjs", original);
      rmSync(absolute);
      symlinkSync("selector-copy.mjs", absolute);
    } else chmodSync(absolute, statSync(absolute).mode ^ 0o111);
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /projection.*(differs|dirty)/i, kind);
    assert.deepEqual(f.commands(), []);
  }
});

test("a projection helper update may be advertised before a lock change", (t) => {
  const { f } = initialize(t);
  const path = "scripts/security/cargo-lock-projection.py";
  f.write(
    path,
    `${readFileSync(join(f.repo, path), "utf8")}\n# reviewed update\n`,
  );
  f.commit();
  expectPush(f, false);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.write("Cargo.lock", lock({ sdk: "e" }));
  f.commit();
  expectPush(f, true);
});

test("workspace manifest projection inputs are checked before selection", (t) => {
  for (const path of [
    "scripts/security/cargo-workspace-projection.py",
    "scripts/security/cargo-lock-projection.py",
    "scripts/security/formal-proof-lock-history.mjs",
    "scripts/security/formal-proof-manifest-set.mjs",
  ]) {
    const f = fixture(t);
    const policy = structuredClone(registry);
    policy.suites.push({
      id: "authority",
      implementation: ["src/authority", "crates/domain/Cargo.toml"],
      manifestProjection: {
        path: "Cargo.toml",
        package: "crates/domain/Cargo.toml",
        lock: "Cargo.lock",
        root: "opensesame-domain",
      },
      proofs: ["spec/formal/authority/proof"],
      command: ["npm", "run", "verify:authority-formal"],
    });
    f.pin(policy);
    f.write("spec/formal/proof-registry.json", JSON.stringify(policy));
    f.write("spec/formal/proof-requirements.json", JSON.stringify(policy));
    f.write("spec/formal/authority/proof", "proof\n");
    f.write("Cargo.toml", "[workspace]\nresolver = '2'\n");
    f.write(
      "crates/domain/Cargo.toml",
      "[package]\nname = 'opensesame-domain'\nversion = '0.1.0'\n",
    );
    f.write("Cargo.lock", "version = 4\n");
    f.write(
      "scripts/security/cargo-workspace-projection.py",
      "# original helper\n",
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
    const contents = readFileSync(join(f.repo, path), "utf8");
    f.write(
      path,
      path.endsWith(".mjs")
        ? `${contents}\n// changed\n`
        : "print('{\"changed\":false}')\n",
    );
    f.write("Cargo.toml", "[workspace]\nresolver = '3'\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, path);
    assert.match(result.stderr, /projection.*changed/i, path);
    assert.deepEqual(f.commands(), []);
  }
});

function multipackageFixture(t) {
  const f = fixture(t);
  const policy = structuredClone(registry);
  const manifests = [
    "crates/domain/Cargo.toml",
    "crates/shared/deeper/Cargo.toml",
  ];
  policy.suites.push({
    id: "authority",
    implementation: [
      "src/authority",
      ...manifests,
      "crates/domain/build.rs",
      "crates/shared/deeper/build.rs",
      "crates/Cargo.toml",
      "crates/shared/Cargo.toml",
    ],
    lockProjection: { path: "Cargo.lock", root: "opensesame-domain" },
    manifestProjection: {
      path: "Cargo.toml",
      package: manifests[0],
      lock: "Cargo.lock",
      root: "opensesame-domain",
      manifests,
    },
    proofs: ["spec/formal/authority/proof"],
    command: ["npm", "run", "verify:authority-formal"],
  });
  f.pin(policy);
  f.write("spec/formal/proof-registry.json", JSON.stringify(policy));
  f.write("spec/formal/proof-requirements.json", JSON.stringify(policy));
  f.write("spec/formal/authority/proof", "proof\n");
  f.write("Cargo.toml", "[workspace]\nresolver = '2'\n");
  f.write("Cargo.lock", lock());
  for (const path of manifests)
    f.write(path, "[package]\nname = 'example'\nversion = '0.1.0'\n");
  f.write(
    "scripts/security/cargo-workspace-projection.py",
    "# original helper\n",
  );
  f.write(
    "scripts/security/cargo-workspace-multipackage.py",
    "# original helper\n",
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

test("multipackage projection checks its full helper chain for every input", (t) => {
  for (const input of [
    "Cargo.toml",
    "Cargo.lock",
    "crates/domain/Cargo.toml",
    "crates/shared/deeper/Cargo.toml",
    "crates/Cargo.toml",
    "crates/shared/Cargo.toml",
  ]) {
    const f = multipackageFixture(t);
    f.write(input, "# changed projection input\n");
    f.write(
      "scripts/security/cargo-workspace-multipackage.py",
      "print('{\"changed\":false}')\n",
    );
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, input);
    assert.match(result.stderr, /projection.*changed/i, input);
    assert.deepEqual(f.commands(), []);
  }
});

test("an unrelated package manifest does not trigger multipackage provenance", (t) => {
  const f = multipackageFixture(t);
  f.write("other/Cargo.toml", "[package]\nname = 'other'\nversion = '0.1.0'\n");
  f.write(
    "scripts/security/cargo-workspace-multipackage.py",
    "# independent runner update\n",
  );
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), []);
});

test("ignored optional Cargo inputs fail selected proofs but do not block unrelated pushes", (t) => {
  for (const path of [".cargo/config.toml", "spec/formal/authority/build.rs"]) {
    for (const selected of [true, false]) {
      const f = fixture(t);
      installHook(f);
      const pins = "scripts/security/formal-proof-runner-pins.json";
      const rows = JSON.parse(readFileSync(join(f.repo, pins), "utf8"));
      const suite = rows.find((row) => row[0] === "suite" && row[1] === "a");
      suite[4] = [".cargo"];
      suite[5] = ["spec/formal/authority/build.rs"];
      f.write(pins, JSON.stringify(rows));
      f.commit();
      f.git(
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/main",
      );
      f.write(selected ? "src/a" : "src/other", "changed\n");
      f.commit();
      writeFileSync(
        join(f.repo, ".git/info/exclude"),
        ".cargo/config.toml\nspec/formal/authority/build.rs\n",
      );
      f.write(path, "ignored execution metadata\n");
      assert.equal(f.git("status", "--porcelain"), "");
      const result = push(f, "HEAD", "refs/heads/main");
      if (selected) {
        assert.notEqual(result.status, 0);
        assert.match(
          result.stderr,
          /optional runner metadata .* differs from committed HEAD/i,
        );
      } else assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.commands(), []);
    }
  }
});
