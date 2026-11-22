import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parsePushRefs, parseRegistry } from "./formal-proof-push-gate.mjs";
import {
  fixture,
  installHook,
  nil,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

const proofRequirements = new URL(
  "../../spec/formal/proof-requirements.json",
  import.meta.url,
);

test("rejects malformed refs and registry without executing Git or proofs", () => {
  const oid = "a".repeat(40);
  for (const input of [
    `refs/heads/a ${oid} refs/heads/a ${nil} \n`,
    `refs/heads/a ${oid} refs/heads/a bad\n`,
    `refs/heads/a ${oid} refs/heads/../bad ${nil}\n`,
    `refs/heads/a ${nil} refs/heads/a ${oid}\n`,
    `(delete) ${nil} refs/heads/a ${nil}\n`,
    `refs/heads/a ${oid} refs/heads/a ${nil}\n\n`,
    `refs/heads/a ${oid} refs/heads/a ${nil}\nrefs/heads/b ${oid} refs/heads/a ${nil}\n`,
  ])
    assert.throws(() => parsePushRefs(Buffer.from(input)), /Malformed/);
  assert.deepEqual(parsePushRefs(Buffer.alloc(0)), []);
  assert.throws(
    () => parseRegistry(Buffer.from('{"version":1,"suites":[]}')),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseRegistry(
        Buffer.from(
          JSON.stringify({
            ...registry,
            suites: [{ ...registry.suites[0], command: ["sh", "-c", "true"] }],
          }),
        ),
      ),
    /Invalid/,
  );
});

test("registry boundaries reject non-string ids, paths and commands", () => {
  for (const value of [null, 7, true, {}, []]) {
    for (const suite of [
      { ...registry.suites[0], id: value },
      { ...registry.suites[0], implementation: [value] },
      { ...registry.suites[0], proofs: [value] },
      { ...registry.suites[0], command: ["npm", "run", value] },
    ]) {
      const input = Buffer.from(
        JSON.stringify({ version: 1, suites: [suite] }),
      );
      assert.throws(() => parseRegistry(input), /Invalid formal proof suite/);
    }
  }
});

test("manifest projection descriptors reject ambiguous and untracked inputs", () => {
  const suite = {
    ...registry.suites[0],
    implementation: ["crates/domain/Cargo.toml"],
    manifestProjection: {
      path: "Cargo.toml",
      package: "crates/domain/Cargo.toml",
      lock: "Cargo.lock",
      root: "opensesame-domain",
    },
  };
  for (const change of [
    { path: "nested/Cargo.toml" },
    { package: "../other/Cargo.toml" },
    { package: "crates/other/Cargo.toml" },
    { lock: "other.lock" },
    { root: "../domain" },
    { unexpected: true },
  ]) {
    const input = Buffer.from(
      JSON.stringify({
        version: 1,
        suites: [
          {
            ...suite,
            manifestProjection: { ...suite.manifestProjection, ...change },
          },
        ],
      }),
    );
    assert.throws(() => parseRegistry(input), /Invalid formal proof suite/);
  }
});

test("runs only suites mapped to the pushed implementation and propagates failure", (t) => {
  const f = fixture(t);
  f.write("src/a", "a1\n");
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  const failure = f.run(f.tuple(target), { FORMAL_TEST_STATUS: "9" });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /suite a failed/);
});

test("ignores unrelated and proof-only changes, but detects add, delete and rename", (t) => {
  for (const operation of ["other", "proof", "add", "delete", "rename"]) {
    const f = fixture(t);
    if (operation === "other") f.write("src/other", "changed\n");
    if (operation === "proof") f.write("spec/formal/a/proof", "changed\n");
    if (operation === "add") f.write("src/added", "added\n");
    if (operation === "delete") rmSync(join(f.repo, "src/a"));
    if (operation === "rename")
      renameSync(join(f.repo, "src/a"), join(f.repo, "src/renamed"));
    const target = f.commit();
    const result = f.run(f.tuple(target));
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      ["add", "delete", "rename"].includes(operation) ? ["run verify:a"] : [],
      operation,
    );
  }
});

test("new branches compare against the actual remote history, and deletion-only updates skip proof", (t) => {
  for (const changed of ["src/other", "src/b"]) {
    const f = fixture(t);
    f.write(changed, "new branch\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, nil, "refs/heads/new"));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.commands(), changed === "src/b" ? ["run verify:b"] : []);
    const deletion = f.run(f.tuple(nil));
    assert.equal(deletion.status, 0, deletion.stderr);
  }
});

test("fetches previously unknown remote tips to compare a new branch accurately", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other");
  mkdirSync(other);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: other,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("fetch", "-q", f.remote, "refs/heads/main");
  git("checkout", "-q", "-b", "other", "FETCH_HEAD");
  writeFileSync(join(other, "src/b"), "remote branch\n");
  git("add", "src/b");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "remote change");
  const remoteTip = git("rev-parse", "HEAD");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    f.remote,
    "HEAD:refs/heads/other",
  );
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: f.repo }).status,
    0,
  );
  f.write("src/a", "local branch\n");
  const target = f.commit();
  const result = f.run(f.tuple(target, nil, "refs/heads/new"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  assert.equal(
    spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: f.repo }).status,
    0,
  );
});

test("native push selects the independent NATS suite only for mapped history", (t) => {
  const required = JSON.parse(readFileSync(proofRequirements));
  const nats = "crates/task-bus/src/nats_connect.rs";
  const gateway = "crates/gateway/src/transport/source_trust_selection.rs";
  const bounded = "crates/transport-security/src/bounded.rs";
  const client = "crates/transport-security/src/client.rs";
  const lib = "crates/transport-security/src/lib.rs";
  const proof = "spec/formal/source-trust-selection/SourceTrustSelection.lean";
  for (const operation of [
    "nats",
    "gateway",
    "shared-bounded",
    "shared-client",
    "shared-lib",
    "unrelated",
    "proof",
    "test-only",
    "reverted",
  ]) {
    const f = fixture(t);
    f.pin(required);
    f.write("spec/formal/proof-registry.json", JSON.stringify(required));
    f.write("spec/formal/proof-requirements.json", JSON.stringify(required));
    for (const suite of required.suites)
      for (const path of suite.proofs) f.write(path, "proof\n");
    f.write(nats, "before\n");
    f.write(gateway, "before\n");
    f.write(bounded, "before\n");
    f.write(client, "before\n");
    f.write(lib, "before\n");
    installHook(f);
    f.git(
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/main",
    );
    const changed = {
      nats,
      gateway,
      "shared-bounded": bounded,
      "shared-client": client,
      "shared-lib": lib,
      proof,
      unrelated: "docs/unrelated.md",
      "test-only": "crates/task-bus/src/nats_live_roles.rs",
      reverted: nats,
    }[operation];
    f.write(changed, "changed\n");
    if (operation === "reverted") {
      f.commit();
      f.write(changed, "before\n");
    }
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    const selectionByOperation = {
      gateway: [
        "source-lifetime",
        "source-trust-selection",
        "spiffe-peer-domain",
      ],
      "shared-bounded": [
        "source-trust-selection",
        "spiffe-peer-domain",
        "nats-trust-rotation",
      ],
      "shared-client": [
        "source-lifetime",
        "source-trust-selection",
        "spiffe-peer-domain",
        "nats-trust-rotation",
      ],
      "shared-lib": [
        "spiffe",
        "source-lifetime",
        "source-trust-selection",
        "spiffe-peer-domain",
        "nats-trust-rotation",
        "source-history",
      ],
      nats: ["nats-trust-rotation"],
      reverted: ["nats-trust-rotation"],
    };
    const selected = selectionByOperation[operation] ?? [];
    assert.deepEqual(
      f.commands(),
      selected.map(
        (id) =>
          `run ${required.suites.find((suite) => suite.id === id).command[2]}`,
      ),
      operation,
    );
  }
});

test("plans multiple refs and refuses to verify non-HEAD commits or dirty source", async (t) => {
  const f = fixture(t);
  const { planPush } = await import(
    pathToFileURL(join(f.controller, "security/formal-proof-push-gate.mjs"))
      .href
  );
  f.write("src/a", "a1\n");
  const first = f.commit();
  f.write("src/b", "b1\n");
  const second = f.commit();
  const input =
    f.tuple(first, f.base, "refs/heads/a") +
    f.tuple(second, first, "refs/heads/b");
  const plan = planPush(f.repo, parsePushRefs(Buffer.from(input)), "origin");
  assert.deepEqual(
    plan.map((p) => [p.target, p.suites.map((s) => s.id)]),
    [
      [first, ["a"]],
      [second, ["b"]],
    ],
  );
  const multi = f.run(input);
  assert.notEqual(multi.status, 0);
  assert.match(multi.stderr, /non-HEAD commit or multiple pushed tips/);
  assert.deepEqual(f.commands(), []);
  f.write("src/other", "dirty\n");
  const dirty = f.run(f.tuple(second));
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean worktree/);
  assert.deepEqual(f.commands(), []);
});

test("a dirty or removed registry cannot mask a previously mapped implementation", (t) => {
  const f = fixture(t);
  f.write("src/a", "changed\n");
  const target = f.commit();
  f.write(
    "spec/formal/proof-registry.json",
    JSON.stringify({ version: 1, suites: [registry.suites[1]] }),
  );
  const dirty = f.run(f.tuple(target));
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean worktree/);
  f.commit();
  const removed = f.git("rev-parse", "HEAD");
  const result = f.run(f.tuple(removed));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required formal proof suite a is missing/i);
  assert.deepEqual(f.commands(), []);
});

test("transport lib changes select SPIFFE proofs while authority proof-only edits skip", (t) => {
  const requirements = JSON.parse(
    readFileSync(
      new URL("../../spec/formal/proof-requirements.json", import.meta.url),
    ),
  );
  const lib = "crates/transport-security/src/lib.rs";
  const authorityProof = "spec/formal/authority/conformance.rs";
  const selected = requirements.suites.filter((suite) =>
    suite.implementation.includes(lib),
  );
  assert.deepEqual(
    selected.map((suite) => suite.id),
    [
      "spiffe",
      "source-lifetime",
      "source-trust-selection",
      "spiffe-peer-domain",
      "nats-trust-rotation",
      "source-history",
    ],
  );
  assert.ok(
    requirements.suites.every(
      (suite) => !suite.implementation.includes(authorityProof),
    ),
  );
  const authority = requirements.suites.find(
    (suite) => suite.id === "authority",
  );
  const policy = { version: 1, suites: [authority, ...selected] };
  for (const changed of [lib, authorityProof]) {
    const f = fixture(t);
    f.pin(policy);
    f.write(
      "scripts/security/formal-proof-manifest-set.mjs",
      readFileSync(new URL("./formal-proof-manifest-set.mjs", import.meta.url)),
    );
    for (const name of ["proof-registry.json", "proof-requirements.json"])
      f.write(`spec/formal/${name}`, JSON.stringify(policy));
    for (const suite of policy.suites)
      for (const proof of suite.proofs) f.write(proof, "proof\n");
    f.write(changed, "before\n");
    const base = f.commit();
    f.write(changed, "after\n");
    const result = f.run(f.tuple(f.commit(), base));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      f.commands(),
      changed === lib ? selected.map((suite) => `run ${suite.command[2]}`) : [],
    );
  }
});
