import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkReleaseMeta,
  releaseMetaFromEnv,
  writeReleaseMeta,
} from "./cd-release-meta.mjs";

const env = {
  VERSION: "0.0.0-alpha.4",
  NPM_DIST_TAG: "alpha",
  GITHUB_SHA: "abc1234def5678",
  GITHUB_RUN_ID: "4242",
  EXPECTED_VERSION: "0.0.0-alpha.4",
};

test("release metadata freezes version, alpha tag, sha, and run id", () => {
  assert.deepEqual(releaseMetaFromEnv(env), {
    version: "0.0.0-alpha.4",
    npm_dist_tag: "alpha",
    sha: "abc1234def5678",
    run_id: "4242",
  });
  assert.throws(
    () => releaseMetaFromEnv({ ...env, NPM_DIST_TAG: "latest" }),
    /refusing dist-tag latest/,
  );
  assert.throws(
    () => releaseMetaFromEnv({ ...env, VERSION: "" }),
    /missing version/,
  );
});

test("check accepts only the staged tree from this run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cd-meta-"));
  try {
    const metaPath = join(dir, "release.json");
    const packagePath = join(dir, "package.json");
    await writeReleaseMeta(metaPath, env);
    await writeFile(
      packagePath,
      `${JSON.stringify({ name: "@opensesame-labs/cli", version: env.VERSION })}\n`,
    );
    const checked = await checkReleaseMeta(metaPath, packagePath, env);
    assert.equal(checked.version, env.VERSION);
    const raw = JSON.parse(await readFile(metaPath, "utf8"));
    assert.equal(raw.run_id, "4242");
    await writeFile(
      packagePath,
      `${JSON.stringify({ version: "0.0.0-alpha.5" })}\n`,
    );
    await assert.rejects(
      () => checkReleaseMeta(metaPath, packagePath, env),
      /staged 0\.0\.0-alpha\.5 != metadata 0\.0\.0-alpha\.4/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check rejects a metadata sha or tag from another run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cd-meta-"));
  try {
    const metaPath = join(dir, "release.json");
    const packagePath = join(dir, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify({ version: env.VERSION })}\n`,
    );
    await writeReleaseMeta(metaPath, {
      ...env,
      GITHUB_SHA: "ffffffffffffffff",
    });
    await assert.rejects(
      () => checkReleaseMeta(metaPath, packagePath, env),
      /metadata sha/,
    );
    await writeReleaseMeta(metaPath, { ...env, NPM_DIST_TAG: "next" });
    await assert.rejects(
      () => checkReleaseMeta(metaPath, packagePath, env),
      /preview tag must stay alpha/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
