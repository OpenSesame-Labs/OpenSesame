/**
 * Registry version wait shared by `cd-preview-smoke.mjs` and
 * `cd-registry-wait.mjs`: the deadline poll, the cache-busted registry URLs,
 * and the exact-version, packument, and dist-tags reads. The smoke script
 * re-exports the public names, so callers import from `cd-preview-smoke.mjs`.
 */
import { setTimeout as delay } from "node:timers/promises";
import { isJsonObject, readString } from "../lib/json-boundary.mjs";

export const CLI_PACKAGE = "@opensesame-labs/cli";
export const WEB_PWA_PACKAGE = "@opensesame-labs/web-pwa";
export const DEFAULT_REGISTRY_DEADLINE_MS = 300_000;
export const DEFAULT_REGISTRY_POLL_MS = 2_500;
export const REGISTRY = "https://registry.npmjs.org";

/**
 * Retry `fn` until it returns or `deadlineMs` elapses from the start.
 * Sleep `pollMs` between failures when another try still fits in the deadline.
 * A deadline of 0 is a single attempt.
 */
export async function pollUntilDeadline(
  deadlineMs,
  pollMs,
  sleep,
  fn,
  now = Date.now,
) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 0) {
    throw new Error(
      "SMOKE_REGISTRY_DEADLINE_MS must be a non-negative integer",
    );
  }
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error("SMOKE_REGISTRY_POLL_MS must be a positive integer");
  }
  const started = now();
  const deadline = started + deadlineMs;
  const maxAttempts = Math.floor(deadlineMs / pollMs) + 1;
  let last = new Error("preview smoke failed");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error instanceof Error ? error : new Error("preview smoke failed");
      if (attempt === maxAttempts) break;
      // The next try has to start at or before the deadline. A deadline of 0
      // is one attempt: now() + pollMs is already past it.
      if (now() + pollMs > deadline) break;
      await sleep(pollMs);
      if (now() > deadline) break;
    }
  }
  throw last;
}

const PUBLISHED_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
let registryPollNonce = 0;

/** Monotonic token. The counter survives a repeated timestamp. */
export function registryPollNonceToken(nowMs) {
  registryPollNonce += 1;
  const stamp = Number.isInteger(nowMs) && nowMs >= 0 ? nowMs : 0;
  return `${stamp.toString(36)}-${registryPollNonce.toString(36)}`;
}

function assertAllowedPublishedPackage(pkg) {
  if (pkg !== CLI_PACKAGE && pkg !== WEB_PWA_PACKAGE) {
    throw new Error(
      "published package must be @opensesame-labs/cli or @opensesame-labs/web-pwa",
    );
  }
}

function assertRegistryNonce(nonce) {
  if (!/^[0-9a-z]+-[0-9a-z]+$/u.test(nonce)) {
    throw new Error("registry cache bust nonce is invalid");
  }
}

function encodedRegistryPackage(pkg) {
  assertAllowedPublishedPackage(pkg);
  return pkg.replace("/", "%2f");
}

/** Registry URL with a `_cd_wait` nonce so a cached miss cannot stick. */
function registryCacheBustUrl(path, nonce) {
  assertRegistryNonce(nonce);
  const url = new URL(`${REGISTRY}/${path}`);
  url.searchParams.set("_cd_wait", nonce);
  return url.href;
}

/**
 * Exact-version document. `npm view` reads the packument, which a registry
 * CDN can keep stale after a 202 accept. A new `_cd_wait` query misses that
 * cache. The version wait also reads the packument and dist-tags; this URL
 * stays the version document.
 */
export function exactPublishedVersionUrl(pkg, expected, nonce) {
  const encoded = encodedRegistryPackage(pkg);
  if (!PUBLISHED_VERSION.test(expected)) {
    throw new Error("EXPECTED_VERSION is not a semver");
  }
  return registryCacheBustUrl(`${encoded}/${expected}`, nonce);
}

/** Packument document. npm clients resolve a version from `versions`. */
export function publishedPackumentUrl(pkg, nonce) {
  return registryCacheBustUrl(encodedRegistryPackage(pkg), nonce);
}

/** Dist-tags document for one allowed package, cache-busted per try. */
export function publishedDistTagsUrl(pkg, nonce) {
  const encoded = encodedRegistryPackage(pkg);
  return registryCacheBustUrl(`-/package/${encoded}/dist-tags`, nonce);
}

function recordListsVersion(record, expected) {
  return isJsonObject(record) && Object.hasOwn(record, expected);
}

/**
 * npm packument shape: `versions[expected]` or a `time[expected]` stamp
 * means the registry has listed the version.
 */
export function publishedPackumentListsVersion(payload, expected) {
  if (!isJsonObject(payload)) return false;
  if (recordListsVersion(payload.versions, expected)) return true;
  return recordListsVersion(payload.time, expected);
}

/**
 * A dist-tag map lists the version when `latest` or any other tag value
 * equals it. Preview publishes `alpha`, production publishes `next`, and
 * `latest` counts when that is the tag that moved.
 */
export function publishedDistTagsIncludeVersion(payload, expected) {
  if (!isJsonObject(payload)) return false;
  if (readString(payload.latest) === expected) return true;
  for (const value of Object.values(payload)) {
    if (readString(value) === expected) return true;
  }
  return false;
}

async function readExactPublishedVersion(pkg, expected, nonce, fetcher) {
  const href = exactPublishedVersionUrl(pkg, expected, nonce);
  const response = await fetcher(href, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const spec = `${pkg}@${expected}`;
  if (!response.ok) {
    throw new Error(`registry ${spec} HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!isJsonObject(payload)) {
    throw new Error(`registry ${spec} response is not an object`);
  }
  const seen = readString(payload.version) ?? "";
  if (seen !== expected) {
    throw new Error(
      `registry ${spec} version returned ${seen === "" ? "empty" : seen} != ${expected}`,
    );
  }
  return seen;
}

async function readRegistryObject(href, fetcher, label) {
  const response = await fetcher(href, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!isJsonObject(payload)) {
    throw new Error(`${label} response is not an object`);
  }
  return payload;
}

async function readPackumentListsVersion(pkg, expected, nonce, fetcher) {
  const label = `registry ${pkg} packument`;
  const payload = await readRegistryObject(
    publishedPackumentUrl(pkg, nonce),
    fetcher,
    label,
  );
  if (!publishedPackumentListsVersion(payload, expected)) {
    throw new Error(`${label} has no ${expected}`);
  }
}

async function readDistTagsIncludeVersion(pkg, expected, nonce, fetcher) {
  const label = `registry ${pkg} dist-tags`;
  const payload = await readRegistryObject(
    publishedDistTagsUrl(pkg, nonce),
    fetcher,
    label,
  );
  if (!publishedDistTagsIncludeVersion(payload, expected)) {
    throw new Error(`${label} have no ${expected}`);
  }
}

/**
 * One try: version document, then packument, then dist-tags. Each request
 * gets its own nonce. A miss throws so the deadline poll can try again.
 */
async function readPublishedVersionOnce(pkg, expected, fetcher, now) {
  const seen = await readExactPublishedVersion(
    pkg,
    expected,
    registryPollNonceToken(now()),
    fetcher,
  );
  await readPackumentListsVersion(
    pkg,
    expected,
    registryPollNonceToken(now()),
    fetcher,
  );
  await readDistTagsIncludeVersion(
    pkg,
    expected,
    registryPollNonceToken(now()),
    fetcher,
  );
  return seen;
}

/**
 * Poll until the version document, packument, and dist-tags all list
 * `expected`. Deadline and poll interval stay the registry smoke budget.
 */
export async function waitForPublishedVersion(expected, options = {}) {
  if (expected === undefined || expected === "") {
    throw new Error("EXPECTED_VERSION is required");
  }
  const pkg = options.pkg ?? CLI_PACKAGE;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  const deadlineMs = options.deadlineMs ?? DEFAULT_REGISTRY_DEADLINE_MS;
  const pollMs = options.pollMs ?? DEFAULT_REGISTRY_POLL_MS;
  return pollUntilDeadline(
    deadlineMs,
    pollMs,
    sleep,
    () => readPublishedVersionOnce(pkg, expected, fetcher, now),
    now,
  );
}
