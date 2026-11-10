/**
 * npm trunk publish with idempotent success when the exact version already exists.
 * Used by .github/actions/publish-npm-package so Preview reruns do not fail on E403.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} stderr
 * @param {string} version
 */
export function isForbiddenRepublishOfVersion(stderr, version) {
  const text = stderr ?? "";
  if (!text.includes("403 Forbidden")) return false;
  if (!/cannot publish over the previously published versions:/iu.test(text)) {
    return false;
  }
  return text.includes(version);
}

/**
 * @param {{ status: number | null, stdout: string, stderr: string }} result
 * @param {string} version
 */
export function classifyNpmPublishResult(result, version) {
  if (result.status === 0) return "published";
  if (
    isForbiddenRepublishOfVersion(`${result.stderr}\n${result.stdout}`, version)
  ) {
    return "already_published";
  }
  return "failed";
}

/**
 * @param {string} packageName
 * @param {string} version
 */
export function npmViewVersion(packageName, version) {
  const result = spawnSync(
    "npx",
    [
      "-y",
      "npm@11.21.1",
      "view",
      `${packageName}@${version}`,
      "version",
      "--registry",
      "https://registry.npmjs.org",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const line = (result.stdout ?? "").trim();
  return line.length > 0 ? line : undefined;
}

/** How often, and how far apart, the registry is asked again after a 403. */
const CONFIRM_ATTEMPTS = 6;
const CONFIRM_WAIT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} cwd
 * @param {string} distTag
 */
function runNpmPublish(cwd, distTag) {
  const result = spawnSync(
    "npx",
    [
      "-y",
      "npm@11.21.1",
      "publish",
      "--access",
      "public",
      "--tag",
      distTag,
      "--provenance",
    ],
    { cwd, encoding: "utf8", env: process.env },
  );
  // Captured to be classified, then shown: the provenance statement and the
  // transparency-log entry npm prints are the record of what was published.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

/**
 * The registry's read side trails its write side: the view that missed
 * before the publish can miss again right after the 403. Ask a few times
 * before deciding the version is not there.
 *
 * @param {(packageName: string, version: string) => string | undefined} view
 * @param {(ms: number) => void} wait
 * @param {string} packageName
 * @param {string} version
 */
export function confirmPublishedVersion(view, wait, packageName, version) {
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    const seen = view(packageName, version);
    if (seen === version) return seen;
    if (attempt < CONFIRM_ATTEMPTS) wait(CONFIRM_WAIT_MS);
  }
  return undefined;
}

/**
 * @param {{
 *   packageName: string;
 *   version: string;
 *   distTag: string;
 *   cwd: string;
 * }} input
 * @param {{
 *   view?: (packageName: string, version: string) => string | undefined;
 *   publish?: (cwd: string, distTag: string) => { status: number | null, stdout: string, stderr: string };
 *   wait?: (ms: number) => void;
 * }} [seams]
 */
export function npmTrunkPublish(input, seams = {}) {
  const view = seams.view ?? npmViewVersion;
  const publish = seams.publish ?? runNpmPublish;
  const wait = seams.wait ?? sleepSync;
  const viewFirst = view(input.packageName, input.version);
  if (viewFirst === input.version) {
    return { outcome: "already_published", viewFirst };
  }
  const result = publish(input.cwd, input.distTag);
  const outcome = classifyNpmPublishResult(result, input.version);
  if (outcome === "already_published") {
    const confirmed = confirmPublishedVersion(
      view,
      wait,
      input.packageName,
      input.version,
    );
    if (confirmed !== input.version) {
      throw new Error(
        `npm reported ${input.version} already published but registry view got ${confirmed ?? "missing"}`,
      );
    }
    return { outcome, viewFirst, confirmAfter403: confirmed };
  }
  if (outcome === "failed") {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `npm publish failed with status ${result.status}`,
    );
  }
  return { outcome, viewFirst };
}

function main() {
  const cwd = process.cwd();
  const manifest = JSON.parse(
    readFileSync(resolve(cwd, "package.json"), "utf8"),
  );
  const version = manifest.version;
  const packageName = manifest.name;
  const distTag = process.env.NPM_DIST_TAG ?? "";
  if (!distTag) throw new Error("NPM_DIST_TAG is required");
  const result = npmTrunkPublish({
    packageName,
    version,
    distTag,
    cwd,
  });
  const line =
    result.outcome === "already_published"
      ? `${version} is already on the registry.`
      : `Published ${version} on ${distTag}.`;
  process.stdout.write(`${line}\n`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
