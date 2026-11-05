import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "../lib/json-boundary.mjs";
import { summarizeSarif } from "./codeql-actions-poisonable-count.mjs";

const script = fileURLToPath(
  new URL("./codeql-actions-poisonable-count.mjs", import.meta.url),
);

test("summarizeSarif counts results by workflow basename", () => {
  const summary = summarizeSarif({
    runs: [
      {
        results: [
          {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: ".github/workflows/ci-prerelease-checks.yml",
                  },
                },
              },
            ],
          },
          {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: ".github/workflows/ci-prerelease-checks.yml",
                  },
                },
              },
            ],
          },
          {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: ".github/workflows/ci.yml" },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byFile, {
    "ci-prerelease-checks.yml": 2,
    "ci.yml": 1,
  });
});

test("poisonable-step count script returns numeric counts", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 600000,
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.ok(Number.isInteger(summary.total));
  assert.ok(summary.total >= 0);
  assert.ok(isJsonObject(summary.byFile));
  let sum = 0;
  for (const [file, count] of Object.entries(summary.byFile)) {
    assert.match(file, /\.ya?ml$/u);
    assert.ok(Number.isInteger(count));
    assert.ok(count > 0);
    sum += count;
  }
  assert.equal(sum, summary.total);
});
