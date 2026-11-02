/**
 * Immutable version metadata for a CD run.
 * The build job writes it once. Preview and Production read that file
 * and refuse to publish a tree that does not match.
 *
 *   node scripts/release/cd-release-meta.mjs write artifacts/cd-meta/release.json
 *   node scripts/release/cd-release-meta.mjs check artifacts/cd-meta/release.json package.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

function requiredString(value, label) {
  if (!isString(value) || value.length === 0) {
    throw new Error(`release metadata missing ${label}`);
  }
  return value;
}

/** Fields the build job freezes before any publish. */
export function releaseMetaFromEnv(env) {
  const meta = {
    version: requiredString(env.VERSION, "version"),
    npm_dist_tag: requiredString(env.NPM_DIST_TAG, "npm_dist_tag"),
    sha: requiredString(env.GITHUB_SHA, "sha"),
    run_id: requiredString(env.GITHUB_RUN_ID, "run_id"),
  };
  if (meta.npm_dist_tag === "latest") {
    throw new Error("refusing dist-tag latest");
  }
  return meta;
}

export async function writeReleaseMeta(path, env) {
  const meta = releaseMetaFromEnv(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * The staged package, the metadata file, and this run must name one version.
 * Preview publishes `alpha`. Production rewrites to `0.0.0-next.N` after
 * this check and does not rebuild.
 */
export async function checkReleaseMeta(metaPath, packagePath, env) {
  const meta = await readJson(metaPath);
  const pkg = await readJson(packagePath);
  const version = requiredString(meta.version, "version");
  const tag = requiredString(meta.npm_dist_tag, "npm_dist_tag");
  const sha = requiredString(meta.sha, "sha");
  requiredString(meta.run_id, "run_id");
  if (tag === "latest") throw new Error("refusing dist-tag latest");
  if (tag !== "alpha") {
    throw new Error(`preview tag must stay alpha, got ${tag}`);
  }
  if (!isString(pkg.version) || pkg.version !== version) {
    throw new Error(`staged ${pkg.version} != metadata ${version}`);
  }
  const expectedVersion = requiredString(
    env.EXPECTED_VERSION,
    "expected version",
  );
  if (version !== expectedVersion) {
    throw new Error(`metadata ${version} != planned ${expectedVersion}`);
  }
  const expectedSha = requiredString(env.GITHUB_SHA, "sha");
  if (sha !== expectedSha) {
    throw new Error(`metadata sha ${sha} != run ${expectedSha}`);
  }
  if (meta.run_id !== requiredString(env.GITHUB_RUN_ID, "run_id")) {
    throw new Error("metadata run_id does not match this run");
  }
  return meta;
}

async function main(argv, env) {
  const [command, left, right] = argv;
  if (command === "write" && isString(left) && left.length > 0) {
    await writeReleaseMeta(left, env);
    return;
  }
  if (
    command === "check" &&
    isString(left) &&
    left.length > 0 &&
    isString(right) &&
    right.length > 0
  ) {
    await checkReleaseMeta(left, right, env);
    return;
  }
  throw new Error(
    "Usage: cd-release-meta.mjs write META.json | check META.json PACKAGE.json",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
