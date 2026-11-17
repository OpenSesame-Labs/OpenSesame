import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { stagePagesRelease } from "./prepare-pages-release.mjs";

test("stagePagesRelease bundles dist and a local serve bin", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pages-release-test-"));
  try {
    const pages = join(repositoryRoot, "apps/pages");
    const dist = join(pages, "dist");
    const scripts = join(repositoryRoot, "scripts/release");
    await mkdir(dist, { recursive: true });
    await mkdir(scripts, { recursive: true });
    await writeFile(join(pages, "package.json"), '{"description":"fixture"}\n');
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>PWA</title>\n",
    );
    await writeFile(
      join(dist, "manifest.webmanifest"),
      '{"name":"OpenSesame"}\n',
    );
    const serveSource = fileURLToPath(
      new URL("./pages-pwa-serve.mjs", import.meta.url),
    );
    await copyFile(serveSource, join(scripts, "pages-pwa-serve.mjs"));
    const releaseDir = await stagePagesRelease("0.0.0-alpha.0", {
      repositoryRoot,
    });
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
      await readFile(serveSource, "utf8"),
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
