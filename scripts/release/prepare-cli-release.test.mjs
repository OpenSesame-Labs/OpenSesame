import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stageCliRelease } from "./prepare-cli-release.mjs";

test("stageCliRelease writes a public publish manifest at the planned version", async () => {
  await mkdir(join(process.cwd(), "packages/cli/dist"), { recursive: true });
  await writeFile(join(process.cwd(), "packages/cli/dist/bin.js"), "// stub\n");
  const releaseDir = await stageCliRelease("0.1.0-nightly.20261102");
  const manifest = JSON.parse(
    await readFile(join(releaseDir, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@opensesame-labs/cli");
  assert.equal(manifest.version, "0.1.0-nightly.20261102");
  assert.equal(manifest.bin.opensesame, "dist/bin.js");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.publishConfig.provenance, true);
});
