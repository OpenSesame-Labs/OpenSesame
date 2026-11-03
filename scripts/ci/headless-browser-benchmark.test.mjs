import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEADLESS_BENCH_BACKEND_KEYS,
  selectHeadlessBenchBackends,
} from "./headless-browser-benchmark.mjs";

test("selectHeadlessBenchBackends defaults to the CD-relevant trio", () => {
  assert.deepEqual(selectHeadlessBenchBackends(undefined), [
    "system",
    "cft",
    "pw-hshell",
  ]);
});

test("selectHeadlessBenchBackends accepts an explicit subset", () => {
  assert.deepEqual(selectHeadlessBenchBackends("system,stagehand"), [
    "system",
    "stagehand",
  ]);
});

test("selectHeadlessBenchBackends rejects unknown keys", () => {
  assert.throws(
    () => selectHeadlessBenchBackends("system,nope"),
    /Unknown HEADLESS_BENCH_BACKENDS/,
  );
});

test("selectHeadlessBenchBackends documents every backend key", () => {
  assert.ok(HEADLESS_BENCH_BACKEND_KEYS.length > 0);
});
