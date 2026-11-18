import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readPreparedPublish,
  tarballIntegrity,
  validatePublishManifest,
} from "./prepare-npm-publish.mjs";

const name = "@opensesame-labs/cli";
const good = {
  name,
  version: "0.0.0-alpha.23",
  publishConfig: { access: "public", provenance: true },
};

test("only the workflow's expected package, prerelease and safe publish configuration are accepted", () => {
  assert.deepEqual(validatePublishManifest(good, "alpha", name), {
    name,
    version: good.version,
    tag: "alpha",
  });
  for (const value of [
    { ...good, name: "@opensesame-labs/web-pwa" },
    { ...good, version: "0.0.0-alpha.23-extra" },
    { ...good, publishConfig: { registry: "https://attacker.example" } },
    {
      ...good,
      publishConfig: {
        "@opensesame-labs:registry": "https://attacker.example",
      },
    },
    {
      ...good,
      publishConfig: { "//attacker.example/:_authToken": "${NODE_AUTH_TOKEN}" },
    },
    { ...good, publishConfig: { access: "restricted" } },
    { ...good, publishConfig: { provenance: false } },
    { ...good, publishConfig: null },
  ])
    assert.throws(() => validatePublishManifest(value, "alpha", name));
  assert.throws(() => validatePublishManifest(good, "latest", name));
});

test("a prepared tarball is bound to its recorded bytes and cannot be replaced by a symlink", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "opensesame-prepared-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = mkdtempSync(join(temp, "opensesame-publish-"));
  const tarball = join(root, "package.tgz");
  writeFileSync(tarball, "frozen bytes");
  const integrity = tarballIntegrity(tarball);
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({ name, version: good.version, tag: "alpha", integrity }),
  );
  assert.equal(readPreparedPublish(root, temp).integrity, integrity);
  writeFileSync(tarball, "different bytes");
  assert.throws(
    () => readPreparedPublish(root, temp),
    /changed after validation/,
  );
  rmSync(tarball);
  symlinkSync(join(root, "state.json"), tarball);
  assert.throws(() => readPreparedPublish(root, temp));
  chmodSync(root, 0o700);
});
