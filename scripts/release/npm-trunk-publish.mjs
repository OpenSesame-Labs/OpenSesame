/** Publish a validated, frozen tarball; accept reruns only for identical bytes. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createNpmContext,
  npmCli,
  npmConfigArgs,
  npmEnvironment,
} from "./npm-publish-isolation.mjs";
import { readPreparedPublish } from "./prepare-npm-publish.mjs";

export function isForbiddenRepublishOfVersion(stderr, version) {
  const text = stderr ?? "";
  return (
    /cannot publish over the previously published versions:/iu.test(text) &&
    text.includes(version)
  );
}

export function classifyNpmPublishResult(result, version) {
  if (result.status === 0) return "published";
  if (
    isForbiddenRepublishOfVersion(`${result.stderr}\n${result.stdout}`, version)
  )
    return "already_published";
  return "failed";
}

/** Public registry reads run anonymously and cannot inherit artifact npm configuration. */
export function npmViewIntegrity(packageName, version, context) {
  const result = spawnSync(
    process.execPath,
    [
      npmCli(),
      "view",
      `${packageName}@${version}`,
      "dist.integrity",
      "--json",
      ...npmConfigArgs(context),
    ],
    { cwd: context.cwd, encoding: "utf8", env: npmEnvironment(context) },
  );
  if (result.status !== 0) {
    for (const text of [result.stdout, result.stderr]) {
      try {
        if (JSON.parse(text)?.error?.code === "E404") return undefined;
      } catch {
        // Only an explicit registry 404 means the version is absent.
      }
    }
    throw new Error("npm registry lookup failed");
  }
  let integrity;
  try {
    integrity = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm registry returned invalid integrity");
  }
  if (typeof integrity !== "string" || !integrity.trim())
    throw new Error("npm registry returned no integrity");
  return integrity;
}

function sameIntegrity(actual, expected) {
  return (
    typeof actual === "string" && actual.trim().split(/\s+/u).includes(expected)
  );
}

const CONFIRM_ATTEMPTS = 6;
const CONFIRM_WAIT_MS = 5_000;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runNpmPublish(tarball, distTag, context) {
  const result = spawnSync(
    process.execPath,
    [
      npmCli(),
      "publish",
      tarball,
      ...npmConfigArgs(context),
      "--access",
      "public",
      "--tag",
      distTag,
      "--provenance",
    ],
    { cwd: context.cwd, encoding: "utf8", env: npmEnvironment(context, true) },
  );
  // npm prints provenance and transparency-log details for the published artifact.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

/** Confirm duplicate responses despite registry read-side lag, without accepting different bytes. */
export function confirmPublishedIntegrity(
  view,
  wait,
  packageName,
  version,
  expected,
) {
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    let seen;
    try {
      seen = view(packageName, version);
    } catch {
      /* transient lookup failure */
    }
    if (seen !== undefined) {
      if (!sameIntegrity(seen, expected))
        throw new Error(`Published ${version} has different integrity`);
      return seen;
    }
    if (attempt < CONFIRM_ATTEMPTS) wait(CONFIRM_WAIT_MS);
  }
  return undefined;
}

/** The injected seams only replace I/O; production uses the isolated npm context. */
export function npmTrunkPublish(input, seams = {}) {
  const view =
    seams.view ??
    ((name, version) => npmViewIntegrity(name, version, input.context));
  const publish =
    seams.publish ??
    ((tarball, tag) => runNpmPublish(tarball, tag, input.context));
  const wait = seams.wait ?? sleepSync;
  const viewFirst = view(input.packageName, input.version);
  if (viewFirst !== undefined) {
    if (!sameIntegrity(viewFirst, input.integrity))
      throw new Error(`Published ${input.version} has different integrity`);
    return { outcome: "already_published", viewFirst };
  }
  const result = publish(input.tarball, input.distTag);
  const outcome = classifyNpmPublishResult(result, input.version);
  if (outcome === "already_published") {
    const confirmed = confirmPublishedIntegrity(
      view,
      wait,
      input.packageName,
      input.version,
      input.integrity,
    );
    if (confirmed === undefined)
      throw new Error(
        `npm reported ${input.version} already published but registry integrity was unavailable`,
      );
    return { outcome, viewFirst, confirmAfter403: confirmed };
  }
  if (outcome === "failed")
    throw new Error(`npm publish failed with status ${result.status}`);
  return { outcome, viewFirst };
}

function main() {
  const prepared = readPreparedPublish(process.env.OPENSESAME_NPM_PUBLISH_DIR);
  try {
    if (
      process.env.NPM_DIST_TAG !== prepared.tag ||
      process.env.NPM_PACKAGE_NAME !== prepared.name
    ) {
      throw new Error("Prepared npm package identity changed");
    }
    const context = createNpmContext(
      mkdtempSync(join(prepared.root, "invoke-")),
    );
    const result = npmTrunkPublish({
      packageName: prepared.name,
      version: prepared.version,
      distTag: prepared.tag,
      tarball: prepared.tarball,
      integrity: prepared.integrity,
      context,
    });
    const line =
      result.outcome === "already_published"
        ? `${prepared.version} is already on the registry with identical integrity.`
        : `Published ${prepared.version} on ${prepared.tag}.`;
    process.stdout.write(`${line}\n`);
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
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
