import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { stagePagesRelease } from "./prepare-pages-release.mjs";

test("stagePagesRelease bundles dist and a local serve bin", async () => {
  const dist = join(process.cwd(), "apps/pages/dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>PWA</title>\n");
  await writeFile(
    join(dist, "manifest.webmanifest"),
    '{"name":"OpenSesame"}\n',
  );
  const releaseDir = await stagePagesRelease("0.0.0-alpha.0");
  const manifest = JSON.parse(
    await readFile(join(releaseDir, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, NPM_PUBLISH.webPwa.name);
  assert.equal(manifest.version, "0.0.0-alpha.0");
  assert.equal(manifest.bin["opensesame-pages"], "./bin/serve.mjs");
  assert.equal(manifest.publishConfig.access, "public");
  await readFile(join(releaseDir, "dist/index.html"), "utf8");
  await readFile(join(releaseDir, "bin/serve.mjs"), "utf8");
});
