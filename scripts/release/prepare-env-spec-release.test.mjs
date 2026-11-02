import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stageEnvSpecRelease } from "./prepare-env-spec-release.mjs";

test("stageEnvSpecRelease writes a single-file bundle manifest", async () => {
  const releaseDir = await stageEnvSpecRelease("0.1.0-preview.1");
  const manifest = JSON.parse(
    await readFile(join(releaseDir, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@opensesame-labs/env-spec-bridge");
  assert.equal(manifest.version, "0.1.0-preview.1");
  assert.equal(
    manifest.bin["opensesame-env-parse"],
    "./opensesame-env-parse.mjs",
  );
});
