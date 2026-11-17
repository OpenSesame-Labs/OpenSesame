import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { stagePagesRelease } from "./prepare-pages-release.mjs";

test("stagePagesRelease bundles dist and a local serve bin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pages-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "apps/pages/dist");
  await mkdir(dist, { recursive: true });
  await mkdir(join(root, "scripts/release"), { recursive: true });
  await writeFile(
    join(root, "apps/pages/package.json"),
    JSON.stringify({ description: "Test Pages release" }),
  );
  await writeFile(
    join(root, "scripts/release/pages-pwa-serve.mjs"),
    "// test server\n",
  );
  await writeFile(
    join(dist, "index.html"),
    "<!doctype html><title>PWA</title>\n",
  );
  await writeFile(
    join(dist, "manifest.webmanifest"),
    '{"name":"OpenSesame"}\n',
  );
  const releaseDir = await stagePagesRelease("0.0.0-alpha.0", root);
  const manifest = JSON.parse(
    await readFile(join(releaseDir, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, NPM_PUBLISH.webPwa.name);
  assert.equal(manifest.version, "0.0.0-alpha.0");
  assert.equal(manifest.bin["opensesame-pages"], "bin/serve.mjs");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(
    await readFile(join(releaseDir, "dist/index.html"), "utf8"),
    "<!doctype html><title>PWA</title>\n",
  );
  assert.equal(
    await readFile(join(releaseDir, "bin/serve.mjs"), "utf8"),
    "// test server\n",
  );
});
