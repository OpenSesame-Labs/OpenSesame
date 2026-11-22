import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  productionFixture,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

test("protects theorem signatures while allowing a model change with code", (t) => {
  for (const mode of ["model", "signature", "signature-only"]) {
    const f = productionFixture(t, "auth");
    if (mode !== "signature-only") f.write("src/a", "changed\n");
    const name = mode === "model" ? "AuthPolicy" : "required-theorems";
    f.write(`spec/formal/auth/${name}.lean`, "-- updated proof input\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    if (mode === "signature") {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /required-theorems\.lean changed/i);
      assert.deepEqual(f.commands(), []);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const expected = mode === "model" ? ["run verify:auth-formal"] : [];
      assert.deepEqual(f.commands(), expected);
    }
  }
});

test("selects all changed paths in pushed history, including changes subsequently reverted", (t) => {
  const f = fixture(t);
  f.write("src/a", "intermediate\n");
  f.commit();
  f.write("src/a", "a0\n");
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("a metadata change cannot remove requirements from the target", (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, "spec/formal/proof-requirements.json"));
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requirements are missing/);
  assert.deepEqual(f.commands(), []);
});
