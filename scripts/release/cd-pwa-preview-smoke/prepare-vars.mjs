/**
 * Build Hurl variable JSON from staged CD PWA artifacts (no HTTP).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isJsonObject, readString } from "../../lib/json-boundary.mjs";

export const EXTRA_LIVE_FILES = Object.freeze([
  "manifest.webmanifest",
  "sw.js",
]);

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestFile(path) {
  return digestBytes(readFileSync(path));
}

export function normalizePagesBase(url) {
  const text = readString(url);
  if (text === undefined || text.length === 0) {
    throw new Error("PAGES_URL is required");
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Pages URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Pages URL must be a clean HTTPS URL");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}

function readReleaseManifest(distDir, sha) {
  const raw = readFileSync(join(distDir, "release.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!isJsonObject(parsed)) throw new Error("staged release.json is invalid");
  if (parsed.format !== "opensesame-pages-release" || parsed.version !== 1) {
    throw new Error("staged release.json has unexpected format");
  }
  if (parsed.revision !== sha) {
    throw new Error("staged release.json revision does not match GITHUB_SHA");
  }
  if (!isJsonObject(parsed.sha256)) {
    throw new Error("staged release.json is missing sha256 digests");
  }
  const index = readString(parsed.sha256["index.html"]);
  const runtime = readString(parsed.sha256["os-runtime-config.json"]);
  if (
    index === undefined ||
    runtime === undefined ||
    !/^[a-f0-9]{64}$/u.test(index) ||
    !/^[a-f0-9]{64}$/u.test(runtime)
  ) {
    throw new Error("staged release.json digests are incomplete");
  }
  return { index, runtime };
}

export function buildHurlVariables(env) {
  const sha = readString(env.GITHUB_SHA);
  if (sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("Pages smoke requires GITHUB_SHA");
  }
  const expectedVersion = readString(env.EXPECTED_VERSION);
  if (expectedVersion === undefined || expectedVersion.length === 0) {
    throw new Error("EXPECTED_VERSION is required");
  }
  const distDir = resolve(readString(env.STAGED_DIST) ?? "");
  const { index, runtime } = readReleaseManifest(distDir, sha);
  const variables = {
    pages_base: normalizePagesBase(env.PAGES_URL),
    github_sha: sha,
    expected_version: expectedVersion,
    sha256_index: index,
    sha256_os_runtime: runtime,
  };
  for (const file of EXTRA_LIVE_FILES) {
    const path = join(distDir, file);
    const key = file === "manifest.webmanifest" ? "sha256_manifest" : "sha256_sw";
    variables[key] = digestFile(path);
  }
  return variables;
}
