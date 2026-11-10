import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertCliShrinkwrapMatchesWorkspace,
  expectedShrinkwrapDependencies,
  shrinkwrapRootDependencies,
} from "./cli-shrinkwrap.mjs";

test("committed shrinkwrap matches packages/cli publish dependencies", () => {
  assertCliShrinkwrapMatchesWorkspace();
});

test("assertCliShrinkwrapMatchesWorkspace fails on agent-browser drift", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-shrink-"));
  const path = join(dir, "npm-shrinkwrap.json");
  const expected = expectedShrinkwrapDependencies();
  try {
    await writeFile(
      path,
      `${JSON.stringify(
        {
          name: "@opensesame-labs/cli",
          version: "0.0.0-local",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "@opensesame-labs/cli",
              version: "0.0.0-local",
              dependencies: {
                ...expected,
                "agent-browser": "0.41.0",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    assert.throws(
      () => assertCliShrinkwrapMatchesWorkspace(path),
      /CLI shrinkwrap drift/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shrinkwrapRootDependencies reads lockfile v3 root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-shrink-"));
  const path = join(dir, "npm-shrinkwrap.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        packages: {
          "": { dependencies: { "agent-browser": "0.41.2" } },
        },
      })}\n`,
    );
    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(shrinkwrapRootDependencies(parsed), {
      "agent-browser": "0.41.2",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
