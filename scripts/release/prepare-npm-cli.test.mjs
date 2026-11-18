import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NPM_SHA512, NPM_VERSION, prepareNpmCli } from "./prepare-npm-cli.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-npm-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, archive: join(dir, "npm.tgz"), out: join(dir, "extracted") };
}

test("the committed pin matches npm 11.21.1's independently recorded integrity", () => {
  const integrity =
    "YTzL6QBEJXyHcTu0JiUc7RKMp+mzlJtl7rGLmERaXUQeFHIMc9atdr6G9M9C8vDWbv40epoTQAzNL2/PtZVDhQ==";
  assert.equal(NPM_VERSION, "11.21.1");
  assert.equal(NPM_SHA512, Buffer.from(integrity, "base64").toString("hex"));
});

test("a modified tarball is refused before any extraction", (t) => {
  const f = fixture(t);
  writeFileSync(f.archive, "untrusted registry response");
  assert.throws(() => prepareNpmCli(f.archive, f.out), /SHA-512/);
  assert.equal(existsSync(f.out), false);
  assert.deepEqual(readdirSync(f.dir).sort(), ["npm.tgz"]);
});

test("a symlink or oversized tarball is refused before extraction", (t) => {
  const f = fixture(t);
  const real = join(f.dir, "actual.tgz");
  writeFileSync(real, "wrong");
  symlinkSync(real, f.archive);
  assert.throws(() => prepareNpmCli(f.archive, f.out));
  assert.equal(existsSync(f.out), false);
  rmSync(f.archive);
  writeFileSync(f.archive, "");
  truncateSync(f.archive, 16 * 1024 * 1024 + 1);
  assert.throws(() => prepareNpmCli(f.archive, f.out), /bounded regular file/);
  assert.equal(existsSync(f.out), false);
});
