import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CORE_WORKER_DIGEST = /^[a-f0-9]{64}$/;

/** Bind the push wrapper to the exact already-built classic core worker. */
export function coreWorkerImport(dist) {
  const source = readFileSync(join(dist, "sw.js"));
  const digest = createHash("sha256").update(source).digest("hex");
  return {
    digest,
    url: `./sw.js?sha256=${digest}`,
  };
}

/** Refuse a push artifact that lost its source or variant boundary. */
export function assertPushWorkerCore(source, expected) {
  if (!CORE_WORKER_DIGEST.test(expected.digest))
    throw new Error("build-workers: invalid core worker digest");
  if (!source.includes(expected.url))
    throw new Error("build-workers: push worker lost its pinned core import");
  if (!source.includes("__OPENSESAME_WORKER_VARIANT__"))
    throw new Error("build-workers: push worker lost its variant boundary");
  if (!source.includes("importScripts"))
    throw new Error("build-workers: push worker no longer imports the core");
  if (source.includes("__WB_MANIFEST"))
    throw new Error("build-workers: push worker duplicated the core manifest");
  if (!/^\s*[!(]/u.test(source))
    throw new Error("build-workers: push worker lost its isolated wrapper");
}
