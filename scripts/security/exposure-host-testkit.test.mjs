import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  coverageViolations,
  sha256,
  sourceArea,
} from "../lib/exposure-coverage.mjs";
import {
  HOST_TESTKIT_CONTRACT,
  HOST_TESTKIT_CONTROLS,
} from "../lib/exposure-host-testkit.mjs";
import {
  encodeSourceDigest,
  exposureViolations,
  parsePolicy,
  validatePolicy,
} from "../lib/exposure-policy.mjs";
import {
  POLICY,
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";
import { CHECKER_SOURCES } from "./exposure-matrix-gate.mjs";

const ID = "host-testkit-listener";
const baseline = parsePolicy(
  readFileSync(new URL(`../../${POLICY}`, import.meta.url)),
);
const matrix = () => structuredClone(baseline);
const row = (value, id = ID) => value.surfaces.find((item) => item.id === id);
const rules = (value) =>
  exposureViolations(validatePolicy(value)).map((issue) => issue.rule);
const snapshot = (paths = []) => ({
  paths: () => paths,
  mode: () => "100644",
  read: () => Buffer.alloc(0),
});

test("the synthetic listener has its own mandatory, limited classification", () => {
  const value = matrix();
  for (const field of [
    "kind",
    "area",
    "flow",
    "observer",
    "verification",
    "enforcement",
  ])
    assert.equal(row(value)[field], HOST_TESTKIT_CONTRACT[field], field);
  assert.deepEqual(row(value).artifacts, ["authority-api"]);
  assert.deepEqual(row(value).guarantees, []);
  assert.deepEqual(rules(value), []);
  assert.ok(!row(value).controls.includes("joined-listener-lifetime"));
  assert.ok(
    row(value, "host-listeners").controls.includes("joined-listener-lifetime"),
  );
});

for (const control of [
  "all-listeners-classified",
  "explicit-network-bind",
  ...HOST_TESTKIT_CONTROLS,
]) {
  test(`the synthetic listener cannot omit ${control}`, () => {
    const value = matrix();
    row(value).controls = row(value).controls.filter(
      (item) => item !== control,
    );
    assert.ok(rules(value).includes("EM-HOST-TESTKIT-LISTENER"));
  });
}

test("the synthetic listener cannot claim the production joined lifetime or extra controls", () => {
  for (const control of ["joined-listener-lifetime", "step-up"]) {
    const value = matrix();
    row(value).controls.push(control);
    assert.ok(rules(value).includes("EM-HOST-TESTKIT-LISTENER"), control);
  }
});

test("the mandatory synthetic listener cannot be removed, renamed or relabeled", () => {
  for (const field of [
    "remove",
    "id",
    "kind",
    "area",
    "flow",
    "observer",
    "verification",
    "enforcement",
    "artifacts",
    "guarantees",
  ]) {
    const value = matrix();
    if (field === "remove")
      value.surfaces = value.surfaces.filter((item) => item.id !== ID);
    else if (field === "artifacts" || field === "guarantees")
      row(value)[field] = field === "artifacts" ? [] : ["expiry"];
    else
      row(value)[field] = {
        id: "renamed-testkit-listener",
        kind: "listener",
        area: "bitwarden",
        flow: "host-listeners",
        observer: "authenticated",
        verification: "server",
        enforcement: "authoritative",
      }[field];
    assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u, field);
  }
});

test("another listener cannot borrow the synthetic exception", () => {
  const value = matrix();
  value.surfaces.push({
    ...structuredClone(row(value)),
    id: "impostor-testkit-listener",
    flow: "impostor-testkit-listener",
  });
  assert.ok(rules(value).includes("EM-HOST-TESTKIT-LISTENER"));
  const production = matrix();
  row(production, "host-listeners").kind = "testkit-listener";
  assert.throws(
    () => validatePolicy(production),
    /required kind for host-listeners/u,
  );
  const missingJoin = matrix();
  row(missingJoin, "host-listeners").controls = row(
    missingJoin,
    "host-listeners",
  ).controls.filter((item) => item !== "joined-listener-lifetime");
  assert.ok(rules(missingJoin).includes("EM-LISTENERS"));
});

test("every fixed implementation and regression must remain bound to the synthetic row", () => {
  for (const role of ["implementation", "regressions"]) {
    for (const path of HOST_TESTKIT_CONTRACT[role]) {
      const value = matrix();
      row(value)[role] = row(value)[role].filter((item) => item !== path);
      if (!row(value, "host-listeners")[role].includes(path))
        row(value, "host-listeners")[role].push(path);
      assert.ok(
        coverageViolations(value, snapshot()).includes(
          `EM-BINDING: ${ID} is missing its ${role} binding ${path}`,
        ),
        path,
      );
    }
  }
});

test("testkit discovery covers nested test and support files within its bounded lane", () => {
  for (const path of [
    "crates/gateway/src/testkit.rs",
    "crates/gateway/src/testkit/future.rs",
    "crates/gateway/src/testkit/nested/future.rs",
    "crates/gateway/src/testkit/fixtures/listener.rs",
    "crates/gateway/src/testkit/test_support/helper.rs",
    "crates/gateway/src/testkit/test-support/helper.rs",
    "crates/gateway/src/testkit/future_tests.rs",
    "crates/gateway/src/testkit/tests/future.rs",
  ])
    assert.equal(sourceArea(path), "host-admission", path);
  for (const path of [
    "crates/gateway/src/testkits/future.rs",
    "crates/gateway/src/unrelated/future.rs",
  ])
    assert.equal(sourceArea(path), undefined, path);
});

test("a new helper hash on the production listener cannot steal the testkit boundary", () => {
  const value = matrix();
  const path = "crates/gateway/src/testkit/nested/future.rs";
  row(value, "host-listeners").implementation.push(path);
  value.sources[path] = encodeSourceDigest(sha256(Buffer.alloc(0)));
  validatePolicy(value);
  assert.ok(
    coverageViolations(value, snapshot([path])).some((issue) =>
      issue.startsWith(`EM-COVERAGE: unclassified protected source ${path};`),
    ),
  );
});

test("the actual gate rejects changes to fixture, guards and regressions", (t) => {
  const f = gateFixture(t);
  assertClean(f.run());
  for (const path of [
    "crates/gateway/src/testkit/mod.rs",
    "crates/gateway/src/testkit/server.rs",
    "crates/gateway/src/testkit/state.rs",
    "crates/gateway/src/middleware/auth.rs",
    "crates/connection-broker/src/constructor.rs",
    "crates/gateway/tests/testkit.rs",
    "crates/gateway/tests/host-consumer.test.ts",
    "crates/connection-broker/src/constructor_tests.rs",
  ]) {
    f.write(path, `${f.read(path)}\n// unreviewed drift\n`);
    assertBlocked(f.run(), /EM-DRIFT: reviewed implementation changed/u);
    f.restore(path);
  }
});

for (const path of [
  "crates/gateway/src/testkit/fixtures/listener.rs",
  "crates/gateway/src/testkit/test_support/helper.rs",
  "crates/gateway/src/testkit/test-support/helper.rs",
]) {
  test(`a new helper ${path} is rejected in worktree, index and commit snapshots`, (t) => {
    const f = gateFixture(t);
    f.write(path, "pub fn future_fixture() {}\n");
    assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
    f.git(["add", path]);
    assertBlocked(
      f.run(["--staged"]),
      /EM-COVERAGE: unclassified protected source/u,
    );
    const head = f.commit("unclassified testkit helper");
    assertBlocked(
      f.run(["--ref", head]),
      /EM-COVERAGE: unclassified protected source/u,
    );
  });
}

test("the fixture contract is an actual checker dependency", (t) => {
  const f = gateFixture(t);
  const path = "scripts/lib/exposure-host-testkit.mjs";
  assert.ok(CHECKER_SOURCES.includes(path));
  f.write(path, `${f.read(path)}\n// unstaged checker drift\n`);
  assertBlocked(f.run(["--staged"]), /EM-CHECKER-SNAPSHOT/u);
  assertBlocked(f.run(["--ref", f.head]), /EM-CHECKER-SNAPSHOT/u);
});
