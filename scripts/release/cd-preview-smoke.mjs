/**
 * Smoke the Preview publish before Production publishes `0.0.0-next.N`.
 *
 * Resolves `@opensesame-labs/cli@alpha`, installs it, and requires
 * `opensesame --version` to exit 0. When EXPECTED_VERSION is set, both the
 * dist-tag and the command output must match it.
 *
 * `CD_PROOF_GATE_FAIL=1` (workflow_dispatch `proof_gate_fail`) throws
 * `intentional promotion gate proof failure` before any registry call.
 *
 * cd-pwa also sets PAGES_URL. That URL must load, and the Pages release
 * marker must match GITHUB_SHA (`pages-release` verify).
 *
 *   EXPECTED_VERSION=0.0.0-alpha.4 node scripts/release/cd-preview-smoke.mjs
 *   PAGES_URL=https://host/OpenSesame/ GITHUB_SHA=<40 hex> \
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
export const CLI_DIST_TAG = "alpha";
export const CLI_SPEC = `${CLI_PACKAGE}@${CLI_DIST_TAG}`;
export const CLI_BIN = "opensesame";
const REGISTRY = "https://registry.npmjs.org";
const DIST_TAGS_URL = `${REGISTRY}/-/package/@opensesame-labs%2fcli/dist-tags`;

function readCount(value, fallback, label) {
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

async function retry(attempts, sleep, fn) {
  let last = new Error("preview smoke failed");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error instanceof Error ? error : new Error("preview smoke failed");
      if (attempt === attempts) break;
      await sleep(5_000);
    }
  }
  throw last;
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

export async function runPreviewSmoke(env, deps = {}) {
  assertNotProofGateFail(env);
  const fetcher = deps.fetch ?? fetch;
  const runner = deps.run ?? spawnCaptured;
  const verify = deps.verifyPages ?? verifyRelease;
  const sleep = deps.sleep ?? delay;
  const attempts =
    deps.attempts ?? readCount(env.SMOKE_ATTEMPTS, 6, "SMOKE_ATTEMPTS");
  const expected = readString(env.EXPECTED_VERSION);
  const pagesUrl = readString(env.PAGES_URL);
  const sha = readString(env.GITHUB_SHA) ?? "";

  const version = await retry(attempts, sleep, async () => {
    const resolved = distTagVersion(await fetchDistTags(fetcher));
    assertExpectedVersion(resolved, expected);
    await installAndRun(resolved, runner);
    return resolved;
  });

  if (pagesUrl !== undefined && pagesUrl.length > 0) {
    await retry(attempts, sleep, async () => {
      await assertPagesUrlLoads(pagesUrl, fetcher);
      await assertPagesRelease(pagesUrl, sha, verify);
    });
  }
  return version;
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
