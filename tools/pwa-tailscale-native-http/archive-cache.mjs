/** Publish only exact, verified archive bytes into the shared build cache. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_ARCHIVE_BYTES = 1_073_741_824;
const DIGEST = /^[a-f0-9]{64}$/;

async function checkedSize(handle) {
  const info = await handle.stat();
  if (!info.isFile() || info.size < 1 || info.size > MAX_ARCHIVE_BYTES)
    throw new Error("Native build archive size is invalid.");
  return info.size;
}

/** Open without following symlinks and verify the entire archive in bounded memory. */
export async function verifyArchive(path, digest) {
  if (!DIGEST.test(digest)) throw new Error("Native archive pin is invalid.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = await checkedSize(handle);
    const hash = createHash("sha256");
    let actual = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      actual += bytes.length;
      if (actual > size)
        throw new Error("Native build archive size is invalid.");
      hash.update(bytes);
    }
    if (actual !== size || hash.digest("hex") !== digest)
      throw new Error("Native build archive digest differs.");
  } finally {
    await handle.close();
  }
}

async function copyArchive(source, destination) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = await checkedSize(input);
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW;
    const output = await open(destination, flags, 0o600);
    try {
      let copied = 0;
      for await (const bytes of input.createReadStream({ autoClose: false })) {
        copied += bytes.length;
        if (copied > size)
          throw new Error("Native build archive size is invalid.");
        await output.writeFile(bytes);
      }
      if (copied !== size)
        throw new Error("Native build archive size is invalid.");
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/**
 * Stage beside the cache, verify before publication, and never replace another
 * caller's entry. This works when the private download is on another filesystem.
 * The injected copy operation exists solely to exercise cleanup after I/O errors.
 */
export async function publishArchive(
  source,
  destination,
  digest,
  { copy = copyArchive } = {},
) {
  if (!DIGEST.test(digest)) throw new Error("Native archive pin is invalid.");
  const cache = dirname(destination);
  const info = await lstat(cache);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Native archive cache must be an owned directory.");
  const staging = await mkdtemp(join(cache, ".archive-publish-"));
  try {
    const staged = join(staging, "archive.tar.gz");
    await copy(source, staged);
    await verifyArchive(staged, digest);
    try {
      // A hard link makes the fully verified file visible atomically without
      // overwriting an archive published by a concurrent process.
      await link(staged, destination);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await verifyArchive(destination, digest);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
