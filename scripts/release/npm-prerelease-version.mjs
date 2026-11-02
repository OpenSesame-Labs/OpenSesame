/**
 * Tyler CD semver: 0.0.0-<preid>.0 first, then bump the prerelease counter.
 * Dist-tag is the preid (or `next` on Production promotion), never `latest`.
 */
import { spawnSync } from "node:child_process";

export function normalizeReleaseSha(sha) {
  const text = sha ?? "";
  if (text === "") {
    throw new Error("pass --sha or set GITHUB_SHA");
  }
  if (!/^[0-9a-fA-F]{7,}$/u.test(text)) {
    throw new Error(`SHA must be at least 7 hex characters, got ${text}`);
  }
  return text.slice(0, 7).toLowerCase();
}

const semverLine =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/**
 * @param {readonly string[]} versions
 * @param {string} [preid]
 */
export function nextCdPrereleaseVersion(versions, preid = "alpha") {
  if (!/^[0-9A-Za-z-]+$/u.test(preid)) {
    throw new Error(`invalid prerelease id: ${preid}`);
  }
  const pattern = new RegExp(`^0\\.0\\.0-${preid}\\.(\\d+)$`, "u");
  let max = -1;
  for (const raw of versions) {
    const match = pattern.exec(raw);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `0.0.0-${preid}.${max + 1}`;
}

/**
 * @param {string} packageName
 */
export function listNpmVersions(packageName) {
  const result = spawnSync(
    "npm",
    [
      "view",
      packageName,
      "versions",
      "--json",
      "--registry",
      "https://registry.npmjs.org",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    if (/E404|404 Not Found|is not in the npm registry/u.test(stderr)) {
      return [];
    }
    throw new Error(
      `npm view ${packageName} failed: ${stderr || result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim() || "[]");
  if (Array.isArray(parsed)) {
    return parsed.filter((entry) => typeof entry === "string");
  }
  if (typeof parsed === "string") {
    return [parsed];
  }
  return [];
}

/**
 * @param {string} version
 */
export function npmDistTagForPrerelease(version, preid = "alpha") {
  const match = semverLine.exec(version);
  if (!match || !match[4]) {
    throw new Error(`expected a prerelease version, got ${version}`);
  }
  const id = match[4].split(".")[0] ?? "";
  if (id !== preid) {
    throw new Error(`version preid ${id} does not match ${preid}`);
  }
  return preid;
}
