import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { providerS3Esbuild } from "./provider-s3-service.mjs";

function packageAt(root, location, name, version, body = "") {
  const directory = join(root, location);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version, main: "index.cjs" }),
  );
  if (body) writeFileSync(join(directory, "index.cjs"), body);
}

test("S3 signer resolves the app-core esbuild instead of a hoisted copy", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-s3-esbuild-"));
  try {
    packageAt(root, "packages/app-core", "@opensesame/app-core", "0.1.0");
    packageAt(
      root,
      "packages/app-core/node_modules/esbuild",
      "esbuild",
      "0.28.2",
      'module.exports = { version: "0.28.2", owner: "app-core" };',
    );
    packageAt(
      root,
      "node_modules/esbuild",
      "esbuild",
      "0.25.0",
      'module.exports = { version: "0.25.0", owner: "root" };',
    );
    assert.deepEqual(providerS3Esbuild(root), {
      version: "0.28.2",
      owner: "app-core",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S3 signer uses app-core's declared installed esbuild version", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(root, "packages/app-core/package.json"), "utf8"),
  );
  const require = createRequire(join(root, "packages/app-core/package.json"));
  const installed = JSON.parse(
    readFileSync(require.resolve("esbuild/package.json"), "utf8"),
  );
  assert.equal(installed.version, manifest.devDependencies.esbuild);
  assert.equal(providerS3Esbuild(root).version, installed.version);
});
