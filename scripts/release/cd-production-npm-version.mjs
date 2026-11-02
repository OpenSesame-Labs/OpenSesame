/**
 * Production publishes the staged Preview tree under a distinct semver.
 * `0.0.0-alpha.N` becomes `0.0.0-next.N` with the same numeric suffix.
 * Payload files stay; only `package.json` `version` changes, then
 * `npm publish --tag next` via OIDC. Never `npm dist-tag add`.
 *
 *   node scripts/release/cd-production-npm-version.mjs rewrite PACKAGE.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject, isString } from "../lib/json-boundary.mjs";
import {
  CD_PREVIEW_DIST_TAG,
  CD_PRODUCTION_DIST_TAG,
} from "./npm-prerelease-version.mjs";

const ALPHA_VERSION = new RegExp(
  `^0\\.0\\.0-${CD_PREVIEW_DIST_TAG}\\.(0|[1-9]\\d*)$`,
  "u",
);

/**
 * @param {string} version
 */
export function alphaVersionToNextProduction(version) {
  if (!isString(version)) {
    throw new Error("alpha version must be a string");
  }
  const match = ALPHA_VERSION.exec(version);
  if (!match) {
    throw new Error(`expected 0.0.0-${CD_PREVIEW_DIST_TAG}.N, got ${version}`);
  }
  return `0.0.0-${CD_PRODUCTION_DIST_TAG}.${match[1]}`;
}

/**
 * @param {string} packagePath
 */
export async function rewritePackageVersionFile(packagePath) {
  const parsed = JSON.parse(await readFile(packagePath, "utf8"));
  if (!isJsonObject(parsed)) {
    throw new Error("package.json must be a JSON object");
  }
  const version = parsed.version;
  if (!isString(version)) {
    throw new Error("package.json version must be a string");
  }
  const next = alphaVersionToNextProduction(version);
  parsed.version = next;
  await writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return next;
}

async function main(argv) {
  const [command, packagePath] = argv;
  if (
    command === "rewrite" &&
    isString(packagePath) &&
    packagePath.length > 0
  ) {
    const next = await rewritePackageVersionFile(packagePath);
    console.log(`version=${next}`);
    return;
  }
  throw new Error("Usage: cd-production-npm-version.mjs rewrite PACKAGE.json");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
