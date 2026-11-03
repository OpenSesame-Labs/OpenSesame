/**
 * Smoke the Preview publish before Production publishes `0.0.0-next.N`.
 *
 * Resolves `@opensesame-labs/cli@alpha`, installs it, and requires
 * `opensesame --version` to exit 0. When EXPECTED_VERSION is set and
 * SMOKE_PUBLISHED_PACKAGE is unset (CD npm CLI), both the dist-tag and the
 * command output must match it.
 *
 * Registry, dist-tag, install, `--version`, and Pages checks poll until
 * SMOKE_REGISTRY_DEADLINE_MS (default 300000, five minutes) with
 * SMOKE_REGISTRY_POLL_MS (default 2500) between tries. Each check has its
 * own deadline. The version wait GETs
 * `<registry>/<package>/<EXPECTED_VERSION>?_cd_wait=<nonce>`. The nonce is
 * monotonic so a cached miss cannot hide a published version. Success is
 * the JSON `version` field equal to EXPECTED_VERSION. The deadline is not
 * shortened and a miss is not treated as success.
 *
 * CLI CD starts that version wait in the Preview publish job
 * (`cd-registry-wait.mjs`) on the same deadline. When
 * CD_REGISTRY_VERSION_CONFIRMED=1, this script skips only that duplicate
 * wait. Dist-tag equality, `npm install @alpha`, and `opensesame --version`
 * still run.
 *
 * SMOKE_PUBLISHED_PACKAGE defaults to `@opensesame-labs/cli`. CD PWA sets it
 * to `@opensesame-labs/web-pwa` and passes EXPECTED_VERSION from the PWA
 * build. That wait targets web-pwa, then the CLI alpha install still runs.
 * The CLI dist-tag is compared to EXPECTED_VERSION only when the published
 * package is the CLI.
 *
 * `CD_PROOF_GATE_FAIL=1` (workflow_dispatch `proof_gate_fail`) throws
 * `intentional promotion gate proof failure` before any registry call.
 *
 * cd-pwa also sets PAGES_URL. That URL must load, and the Pages release
 * marker must match GITHUB_SHA (`pages-release` verify).
 *
 *   EXPECTED_VERSION=0.0.0-alpha.4 node scripts/release/cd-preview-smoke.mjs
 *   EXPECTED_VERSION=0.0.0-alpha.4 \
 *     SMOKE_PUBLISHED_PACKAGE=@opensesame-labs/web-pwa \
 *     PAGES_URL=https://host/OpenSesame/ GITHUB_SHA=<40 hex> \
 *     node scripts/release/cd-preview-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isJsonObject, readString } from "../lib/json-boundary.mjs";
import { verifyRelease } from "../lib/pages-release.mjs";

export const CLI_PACKAGE = "@opensesame-labs/cli";
export const WEB_PWA_PACKAGE = "@opensesame-labs/web-pwa";
export const CLI_DIST_TAG = "alpha";
export const CLI_SPEC = `${CLI_PACKAGE}@${CLI_DIST_TAG}`;
export const CLI_BIN = "opensesame";
export const DEFAULT_REGISTRY_DEADLINE_MS = 300_000;
export const DEFAULT_REGISTRY_POLL_MS = 2_500;
const REGISTRY = "https://registry.npmjs.org";
const DIST_TAGS_URL = `${REGISTRY}/-/package/@opensesame-labs%2fcli/dist-tags`;

function readNonNegativeInt(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const text = readString(value);
  if (text === undefined || !/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(text);
}

function readPositiveInt(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const text = readString(value);
  if (text === undefined || !/^[1-9]\d*$/u.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(text);
}

export function distTagVersion(payload, tag = CLI_DIST_TAG) {
  if (!isJsonObject(payload)) {
    throw new Error("npm dist-tags response is not an object");
  }
  const version = readString(payload[tag]);
  if (
    version === undefined ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error(`npm dist-tag ${tag} is missing for ${CLI_PACKAGE}`);
  }
  return version;
}

export function assertExpectedVersion(resolved, expected) {
  if (expected === undefined || expected === "") return;
  if (resolved !== expected) {
    throw new Error(`alpha ${resolved} != expected ${expected}`);
  }
}

export function outputHasVersion(stdout, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s|v)${escaped}(?:\\s|$)`, "mu").test(stdout.trim());
}

export function assertVersionOutput(status, stdout, version) {
  if (status !== 0) {
    throw new Error(`${CLI_BIN} --version exited ${status}`);
  }
  if (!outputHasVersion(stdout, version)) {
    throw new Error(`${CLI_BIN} --version did not report ${version}`);
  }
}

export function cliInstallArgs(prefix) {
  return [
    "install",
    "--ignore-scripts",
    "--no-fund",
    "--no-audit",
    "--registry",
    REGISTRY,
    "--prefix",
    prefix,
    CLI_SPEC,
  ];
}

export async function assertPagesUrlLoads(url, fetcher) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Pages URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Pages URL must be a clean HTTPS URL");
  }
  const response = await fetcher(parsed.href, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Pages URL did not load: HTTP ${response.status}`);
  }
  const body = await response.text();
  if (body.length === 0) throw new Error("Pages URL loaded an empty body");
}

export async function assertPagesRelease(url, sha, verify = verifyRelease) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("Pages smoke requires GITHUB_SHA");
  }
  await verify(url, sha);
}

export function spawnCaptured(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      signal: AbortSignal.timeout(120_000),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const take = (chunks, chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => take(stdout, chunk));
    child.stderr.on("data", (chunk) => take(stderr, chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolveRun({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

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

/**
 * Exact-version document. `npm view` reads the packument, which the registry
 * CDN can keep stale after publish. A new `_cd_wait` query misses that cache.
 */
export function exactPublishedVersionUrl(pkg, expected, nonce) {
  if (pkg !== CLI_PACKAGE && pkg !== WEB_PWA_PACKAGE) {
    throw new Error(
      "published package must be @opensesame-labs/cli or @opensesame-labs/web-pwa",
    );
  }
  if (!PUBLISHED_VERSION.test(expected)) {
    throw new Error("EXPECTED_VERSION is not a semver");
  }
  if (!/^[0-9a-z]+-[0-9a-z]+$/u.test(nonce)) {
    throw new Error("registry cache bust nonce is invalid");
  }
  const url = new URL(`${REGISTRY}/${pkg.replace("/", "%2f")}/${expected}`);
  url.searchParams.set("_cd_wait", nonce);
  return url.href;
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

/**
 * Poll until the exact-version registry document's `version` equals `expected`.
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
    async () =>
      readExactPublishedVersion(
        pkg,
        expected,
        registryPollNonceToken(now()),
        fetcher,
      ),
    now,
  );
}

async function fetchDistTags(fetcher) {
  const response = await fetcher(DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`npm dist-tags HTTP ${response.status}`);
  }
  return response.json();
}

async function installAndRun(version, runner) {
  const prefix = await mkdtemp(join(tmpdir(), "cd-preview-smoke-"));
  try {
    const installed = await runner("npm", cliInstallArgs(prefix), {
      cwd: prefix,
    });
    if (installed.status !== 0) {
      throw new Error(`npm install ${CLI_SPEC} failed`);
    }
    const bin = join(prefix, "node_modules", ".bin", CLI_BIN);
    const ran = await runner(bin, ["--version"], { cwd: prefix });
    assertVersionOutput(ran.status, ran.stdout, version);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}

export function assertNotProofGateFail(env) {
  if (readString(env.CD_PROOF_GATE_FAIL) === "1") {
    throw new Error("intentional promotion gate proof failure");
  }
}

function registryVersionConfirmed(env) {
  return readString(env.CD_REGISTRY_VERSION_CONFIRMED) === "1";
}

function publishedPackageName(env) {
  const raw = readString(env.SMOKE_PUBLISHED_PACKAGE);
  if (raw === undefined || raw === "") return CLI_PACKAGE;
  if (raw !== CLI_PACKAGE && raw !== WEB_PWA_PACKAGE) {
    throw new Error(
      "SMOKE_PUBLISHED_PACKAGE must be @opensesame-labs/cli or @opensesame-labs/web-pwa",
    );
  }
  return raw;
}

/** Package targeted by cd-registry-wait.mjs (CLI CD default, PWA when set). */
export function publishedPackageForWait(env) {
  return publishedPackageName(env);
}

export function registryBudget(env, deps = {}) {
  const deadlineMs =
    deps.deadlineMs ??
    readNonNegativeInt(
      env.SMOKE_REGISTRY_DEADLINE_MS,
      DEFAULT_REGISTRY_DEADLINE_MS,
      "SMOKE_REGISTRY_DEADLINE_MS",
    );
  const pollMs =
    deps.pollMs ??
    readPositiveInt(
      env.SMOKE_REGISTRY_POLL_MS,
      DEFAULT_REGISTRY_POLL_MS,
      "SMOKE_REGISTRY_POLL_MS",
    );
  return { deadlineMs, pollMs };
}

export async function runPreviewSmoke(env, deps = {}) {
  assertNotProofGateFail(env);
  const fetcher = deps.fetch ?? fetch;
  const runner = deps.run ?? spawnCaptured;
  const verify = deps.verifyPages ?? verifyRelease;
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  const { deadlineMs, pollMs } = registryBudget(env, deps);
  const expected = readString(env.EXPECTED_VERSION);
  const pkg = publishedPackageName(env);
  const pagesUrl = readString(env.PAGES_URL);
  const sha = readString(env.GITHUB_SHA) ?? "";
  const poll = (fn) => pollUntilDeadline(deadlineMs, pollMs, sleep, fn, now);

  if (
    pkg !== CLI_PACKAGE &&
    (expected === undefined || expected.length === 0)
  ) {
    throw new Error(
      "EXPECTED_VERSION is required when SMOKE_PUBLISHED_PACKAGE is set",
    );
  }

  if (
    expected !== undefined &&
    expected.length > 0 &&
    !registryVersionConfirmed(env)
  ) {
    await waitForPublishedVersion(expected, {
      sleep,
      deadlineMs,
      pollMs,
      now,
      pkg,
      fetch: fetcher,
    });
  }

  const cliExpected = pkg === CLI_PACKAGE ? expected : undefined;
  const cliPoll = poll(async () => {
    const resolved = distTagVersion(await fetchDistTags(fetcher));
    assertExpectedVersion(resolved, cliExpected);
    await installAndRun(resolved, runner);
    return resolved;
  });

  if (pagesUrl !== undefined && pagesUrl.length > 0) {
    const pagesPoll = poll(async () => {
      await assertPagesUrlLoads(pagesUrl, fetcher);
      await assertPagesRelease(pagesUrl, sha, verify);
    });
    const [version] = await Promise.all([cliPoll, pagesPoll]);
    return version;
  }

  return cliPoll;
}

async function main() {
  const version = await runPreviewSmoke(process.env);
  const pages = readString(process.env.PAGES_URL);
  const where = pages !== undefined && pages.length > 0 ? ` and ${pages}` : "";
  console.log(`preview smoke passed for ${CLI_SPEC} ${version}${where}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "preview smoke failed";
    console.error(message);
    process.exit(1);
  });
}
