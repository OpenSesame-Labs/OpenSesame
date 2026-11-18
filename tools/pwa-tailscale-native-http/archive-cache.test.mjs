import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { publishArchive, verifyArchive } from "./archive-cache.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Scratch and cache can live on different mounted filesystems. */
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "native-archive-source-"));
  const cache = await mkdtemp(
    join(dirname(resolve(process.cwd())), ".native-archive-cache-"),
  );
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });
  const bytes = Buffer.from("public native archive fixture\n");
  const digest = hash(bytes);
  const source = join(scratch, "source.download");
  const destination = join(cache, `${digest}.tar.gz`);
  await writeFile(source, bytes);
  return { scratch, cache, bytes, digest, source, destination };
}

test("publishes a verified private download even across different filesystems", async (t) => {
  const f = await fixture(t);
  if ((await stat(f.scratch)).dev !== (await stat(f.cache)).dev) {
    await assert.rejects(rename(f.source, f.destination), { code: "EXDEV" });
  }
  await publishArchive(f.source, f.destination, f.digest);
  assert.deepEqual(await readFile(f.destination), f.bytes);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.equal((await stat(f.destination)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.cache), [`${f.digest}.tar.gz`]);
  await verifyArchive(f.destination, f.digest);
});

test("concurrent publishers retain one complete verified archive", async (t) => {
  const f = await fixture(t);
  const sources = [];
  for (let index = 0; index < 5; index += 1) {
    const source = join(f.scratch, `${index}.download`);
    await writeFile(source, f.bytes);
    sources.push(source);
  }
  await Promise.all(
    sources.map((source) => publishArchive(source, f.destination, f.digest)),
  );
  assert.deepEqual(await readFile(f.destination), f.bytes);
  assert.deepEqual(await readdir(f.cache), [`${f.digest}.tar.gz`]);
});

test("an incomplete staging copy is never visible at the cache key", async (t) => {
  const f = await fixture(t);
  let ready;
  let release;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const resume = new Promise((resolve) => {
    release = resolve;
  });
  const publication = publishArchive(f.source, f.destination, f.digest, {
    copy: async (_source, staged) => {
      await writeFile(staged, f.bytes.subarray(0, 4));
      ready();
      await resume;
      await writeFile(staged, f.bytes);
    },
  });
  try {
    await started;
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  } finally {
    release();
    await publication;
  }
  assert.deepEqual(await readFile(f.destination), f.bytes);
  assert.deepEqual(await readdir(f.cache), [`${f.digest}.tar.gz`]);
});

test("refuses corrupt downloads and existing entries without replacing them", async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, "changed download");
  await assert.rejects(
    publishArchive(f.source, f.destination, f.digest),
    /digest differs/,
  );
  assert.deepEqual(await readdir(f.cache), []);
  await writeFile(f.source, f.bytes);
  await writeFile(f.destination, "corrupt cache entry");
  await assert.rejects(
    publishArchive(f.source, f.destination, f.digest),
    /digest differs/,
  );
  assert.equal(await readFile(f.destination, "utf8"), "corrupt cache entry");
  assert.deepEqual(await readdir(f.cache), [`${f.digest}.tar.gz`]);
});

test("a failed copy removes only its staging directory and never publishes partial data", async (t) => {
  const f = await fixture(t);
  const failure = new Error("simulated copy failure");
  await assert.rejects(
    publishArchive(f.source, f.destination, f.digest, {
      copy: async (_source, staged) => {
        await writeFile(staged, "incomplete");
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await readdir(f.cache), []);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test("refuses empty and oversized files before copying them", async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, "");
  await assert.rejects(
    publishArchive(f.source, f.destination, f.digest),
    /archive size is invalid/,
  );
  const file = await open(f.source, "w");
  try {
    await file.truncate(1_073_741_825);
  } finally {
    await file.close();
  }
  await assert.rejects(
    publishArchive(f.source, f.destination, f.digest),
    /archive size is invalid/,
  );
  assert.deepEqual(await readdir(f.cache), []);
});

test("refuses symbolic links for the source, cache directory, and published entry", async (t) => {
  const f = await fixture(t);
  const sourceLink = join(f.scratch, "source-link");
  await symlink(f.source, sourceLink);
  await assert.rejects(publishArchive(sourceLink, f.destination, f.digest));
  assert.deepEqual(await readdir(f.cache), []);

  const cacheLink = join(f.scratch, "cache-link");
  await symlink(f.cache, cacheLink, "dir");
  await assert.rejects(
    publishArchive(f.source, join(cacheLink, `${f.digest}.tar.gz`), f.digest),
    /owned directory/,
  );
  await symlink(f.source, f.destination);
  await assert.rejects(publishArchive(f.source, f.destination, f.digest));
  assert.equal((await lstat(f.destination)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.deepEqual(await readdir(f.cache), [`${f.digest}.tar.gz`]);
});
