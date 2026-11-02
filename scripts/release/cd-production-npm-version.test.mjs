import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  alphaVersionToNextProduction,
  rewritePackageVersionFile,
} from "./cd-production-npm-version.mjs";

test("alphaVersionToNextProduction keeps the numeric suffix", () => {
  assert.equal(alphaVersionToNextProduction("0.0.0-alpha.0"), "0.0.0-next.0");
  assert.equal(
    alphaVersionToNextProduction("0.0.0-alpha.12"),
    "0.0.0-next.12",
  );
  for (const bad of [
    "0.0.0-next.1",
    "0.0.0-alpha",
    "0.0.0-beta.1",
    "1.0.0",
    "0.0.0-alpha.01",
    "0.0.0-alpha.1.2",
    "",
  ]) {
    assert.throws(() => alphaVersionToNextProduction(bad), /0\.0\.0-alpha\.N/);
  }
  assert.throws(() => alphaVersionToNextProduction(1), /must be a string/);
});

test("rewrite updates version in place and keeps the other fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cd-next-version-"));
  try {
    const packagePath = join(dir, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "@opensesame-labs/cli",
          version: "0.0.0-alpha.7",
          bin: { opensesame: "dist/bin.js" },
        },
        null,
        2,
      )}\n`,
    );
    const next = await rewritePackageVersionFile(packagePath);
    assert.equal(next, "0.0.0-next.7");
    const parsed = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(parsed.version, "0.0.0-next.7");
    assert.equal(parsed.name, "@opensesame-labs/cli");
    assert.deepEqual(parsed.bin, { opensesame: "dist/bin.js" });
    await assert.rejects(
      () => rewritePackageVersionFile(packagePath),
      /0\.0\.0-alpha\.N/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rewrite PACKAGE.json prints the next version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cd-next-cli-"));
  try {
    const packagePath = join(dir, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify({ name: "@opensesame-labs/web-pwa", version: "0.0.0-alpha.3" })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "cd-production-npm-version.mjs"),
        "rewrite",
        packagePath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^version=0\.0\.0-next\.3\n$/u);
    const parsed = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(parsed.version, "0.0.0-next.3");
    assert.equal(parsed.name, "@opensesame-labs/web-pwa");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
