#!/usr/bin/env node
/**
 * Republish Pages Tailscale pins from a verified native distribution.
 *
 *   node scripts/dev/publish-native-tailscale-metadata.mjs --cold [--install]
 *   node scripts/dev/publish-native-tailscale-metadata.mjs --artifacts-dir DIR [--install]
 *
 * Source and manifest pins are sha256 of the raw file bytes. Distribution
 * acceptance always goes through readNativeDistribution; this command does
 * not substitute a previously published digest.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNativeSourceInputs,
  readNativeDistribution,
} from "../../tools/pwa-tailscale-native-http/distribution-cache.mjs";
import {
  assertNativeColdBuildHost,
  nativeDistributionDirectory,
  nativePreparationCommand,
} from "../../tools/pwa-tailscale-native-http/prepare-distribution.mjs";
import { assertNativeTaskResources } from "../../tools/pwa-tailscale-native-http/task-resources.mjs";
import {
  assertNativeFourPhaseProof,
  assertNativePublishedPins,
  publishNativeTailscalePagesMetadata,
} from "../lib/native-wasm-proof.mjs";

const usage =
  "usage: publish-native-tailscale-metadata.mjs (--cold | --artifacts-dir DIR) [--install]";
const digestPattern = /^[a-f0-9]{64}$/;
const sourceMetadataMaxBytes = 65_536;
const manifestMaxBytes = 65_536;
const artifactMaxBytes = 67_108_864;
const archiveMaxBytes = 1_073_741_824;
const metadataPath = "apps/pages/src/lib/capabilities/tailscale-artifacts.json";
const preservedSdkFields = ["version", "browserSDKVersion", "browserSDKHash"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function rejectDuplicate(seen, name) {
  if (seen) throw new Error(`Duplicate ${name}.`);
}

function directoryArgument(value, name) {
  if (value === undefined || value.length === 0 || value.startsWith("-"))
    throw new Error(`${name} requires a directory.`);
  return value;
}

function parseArgs(argv) {
  let cold = false;
  let artifactsDir;
  let install = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cold") {
      rejectDuplicate(cold, arg);
      cold = true;
    } else if (arg === "--install") {
      rejectDuplicate(install, arg);
      install = true;
    } else if (arg === "--artifacts-dir") {
      rejectDuplicate(artifactsDir !== undefined, arg);
      index += 1;
      artifactsDir = directoryArgument(argv[index], arg);
    } else throw new Error(`Unknown argument ${arg}. ${usage}`);
  }
  const selected = Number(cold) + Number(artifactsDir !== undefined);
  if (selected !== 1) throw new Error(usage);
  return { cold, artifactsDir, install };
}

async function present(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readOwnedFile(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes)
      throw new Error("Native input is not a regular owned file in range.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function verifyArchive(path, digest) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > archiveMaxBytes)
      throw new Error("Native build archive size is invalid.");
    if (hash(await handle.readFile()) !== digest)
      throw new Error("Native build archive digest differs.");
  } finally {
    await handle.close();
  }
}

async function fetchArchive(pin, cache, work, label) {
  if (
    !digestPattern.test(pin.archiveSha256) ||
    new URL(pin.archiveURL).protocol !== "https:"
  )
    throw new Error("Native archive pin is invalid.");
  const path = join(cache, `${pin.archiveSha256}.tar.gz`);
  if (await present(path)) {
    await verifyArchive(path, pin.archiveSha256);
    return path;
  }
  const partial = join(work, `${label}.download`);
  await nativePreparationCommand(
    "curl",
    [
      "--fail",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "120",
      "--max-filesize",
      "1073741824",
      "--output",
      partial,
      "--",
      pin.archiveURL,
    ],
    join(work, `${label}-download.log`),
    work,
    125_000,
  );
  await verifyArchive(partial, pin.archiveSha256);
  await rename(partial, path);
  return path;
}

async function assertOwnedDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Native artifacts path must be an owned directory.");
}

async function loadVerifiedArtifacts(artifactsDir) {
  await assertOwnedDirectory(artifactsDir);
  const manifestSha256 = hash(
    await readOwnedFile(
      join(artifactsDir, "native-artifacts.json"),
      manifestMaxBytes,
    ),
  );
  const verified = await readNativeDistribution(artifactsDir, manifestSha256);
  return { artifactsDir, manifestSha256, verified };
}

async function coldArtifacts(root, here, pins, sourceMetadataSha256) {
  assertNativeColdBuildHost();
  const cache = join(root, ".cache/pwa-tailscale-native-http");
  if (await present(cache)) await assertNativeTaskResources(cache);
  const work = join(cache, "work", randomUUID());
  const archives = join(cache, "archives");
  await mkdir(join(work, "tmp"), { recursive: true });
  await mkdir(archives, { recursive: true });
  const source = await fetchArchive(pins.source, archives, work, "source");
  const compiler = await fetchArchive(
    pins.compiler,
    archives,
    work,
    "compiler",
  );
  const output = join(work, "build");
  await nativePreparationCommand(
    process.execPath,
    [join(here, "build.mjs"), source, compiler, output],
    join(work, "build.log"),
    work,
    600_000,
  );
  const refreshed = await assertNativeSourceInputs(here, sourceMetadataSha256);
  const loaded = await loadVerifiedArtifacts(join(output, "artifacts"));
  const proof = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  assertNativeFourPhaseProof(proof, refreshed, loaded.verified.manifest);
  return loaded;
}

function distributionFile(directory, relativePath) {
  if (relativePath.startsWith("/") || relativePath.includes("\0"))
    throw new Error("Native asset path escapes the distribution directory.");
  const target = join(directory, relativePath);
  const remainder = relative(directory, target);
  if (remainder === "" || remainder.startsWith(".."))
    throw new Error("Native asset path escapes the distribution directory.");
  return target;
}

async function copyArtifactTree(from, to) {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = distributionFile(to, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Native artifacts must not contain symbolic links.");
    if (entry.isDirectory()) {
      await mkdir(target);
      await copyArtifactTree(source, target);
      continue;
    }
    if (!entry.isFile())
      throw new Error("Native artifacts must be regular files.");
    await writeFile(target, await readOwnedFile(source, artifactMaxBytes), {
      flag: "wx",
      mode: 0o644,
    });
  }
}

async function installDistribution(
  root,
  sourceMetadataSha256,
  manifestSha256,
  artifactsDir,
) {
  const directory = nativeDistributionDirectory(
    root,
    sourceMetadataSha256,
    manifestSha256,
  );
  const existing = await present(directory);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error(
        "Pinned native distribution path is not an owned directory.",
      );
    await readNativeDistribution(directory, manifestSha256);
    return directory;
  }
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  try {
    await copyArtifactTree(artifactsDir, directory);
    await readNativeDistribution(directory, manifestSha256);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

function assertPreservedSdk(previous) {
  const sdk = previous?.sdk;
  for (const key of preservedSdkFields) {
    const value = sdk?.[key];
    if (value !== `${value}` || value.length < 1)
      throw new Error(`Pages Tailscale metadata is missing sdk.${key}.`);
  }
}

async function writePagesPins(
  path,
  manifest,
  sourceMetadataSha256,
  manifestSha256,
) {
  const previous = JSON.parse(
    (await readOwnedFile(path, 1_048_576)).toString("utf8"),
  );
  assertPreservedSdk(previous);
  const published = publishNativeTailscalePagesMetadata(
    previous,
    manifest,
    sourceMetadataSha256,
    manifestSha256,
  );
  assertNativePublishedPins(published, manifest);
  const temporary = join(
    dirname(path),
    `.${randomUUID()}.tailscale-artifacts.json`,
  );
  await writeFile(temporary, `${JSON.stringify(published, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const root = repositoryRoot();
  const here = join(root, "tools/pwa-tailscale-native-http");
  const sourceMetadataSha256 = hash(
    await readOwnedFile(
      join(root, "tools/pwa-tailscale-native-http/source.json"),
      sourceMetadataMaxBytes,
    ),
  );
  const pins = await assertNativeSourceInputs(here, sourceMetadataSha256);
  const loaded = options.cold
    ? await coldArtifacts(root, here, pins, sourceMetadataSha256)
    : await loadVerifiedArtifacts(resolve(options.artifactsDir));
  if (options.install)
    await installDistribution(
      root,
      sourceMetadataSha256,
      loaded.manifestSha256,
      loaded.artifactsDir,
    );
  await writePagesPins(
    join(root, metadataPath),
    loaded.verified.manifest,
    sourceMetadataSha256,
    loaded.manifestSha256,
  );
  console.log(
    JSON.stringify({
      sourceMetadataSha256,
      manifestSha256: loaded.manifestSha256,
    }),
  );
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
