#!/usr/bin/env node
// CycloneDX SBOM for the source snapshot a candidate was built from.
//
//   SOURCE_SHA=<40 hex> VERSION=<v> GITHUB_REPOSITORY=owner/name GH_TOKEN=... \
//     node scripts/release/sbom.mjs <output.json>
//   node scripts/release/sbom.mjs <output.json> --directory <checkout>
//
// It lists every third-party package the two lockfiles pin: package-lock.json
// and Cargo.lock. That is the set the Pages bundles and the native binaries
// are built from, so it is a superset of what any one artifact contains.
//
// Trusted controller code. It reads the candidate's lockfiles as data, by
// exact commit, and never checks out or runs anything from the candidate. The
// output has no timestamp, so the same snapshot always yields the same bytes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SBOM_PREDICATE = "https://cyclonedx.org/bom";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const ALGORITHMS = { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512" };
// A package needed at runtime anywhere outranks a development-only copy.
const SCOPE_RANK = { required: 2, optional: 1, excluded: 0 };

function npmPurl(name, version) {
  const path = name.startsWith("@")
    ? `${encodeURIComponent(name.slice(0, name.indexOf("/")))}${name.slice(name.indexOf("/"))}`
    : name;
  return `pkg:npm/${path}@${version}`;
}

/** CycloneDX hash entries for an npm Subresource Integrity string. */
function integrityHashes(integrity) {
  const hashes = [];
  for (const part of String(integrity ?? "").split(/\s+/)) {
    const dash = part.indexOf("-");
    const alg = ALGORITHMS[part.slice(0, dash)];
    if (dash < 0 || !alg) continue;
    const content = Buffer.from(part.slice(dash + 1), "base64").toString("hex");
    hashes.push({ alg, content });
  }
  return hashes;
}

function npmScope(entry) {
  if (entry.dev) return "excluded";
  return entry.optional || entry.devOptional ? "optional" : "required";
}

function npmComponent(key, entry) {
  const marker = "node_modules/";
  const name = entry.name ?? key.slice(key.lastIndexOf(marker) + marker.length);
  const purl = npmPurl(name, entry.version);
  const component = {
    type: "library",
    "bom-ref": purl,
    name,
    version: entry.version,
    scope: npmScope(entry),
    purl,
  };
  const hashes = integrityHashes(entry.integrity);
  if (hashes.length > 0) component.hashes = hashes;
  const resolved = String(entry.resolved ?? "");
  if (resolved && !resolved.startsWith(NPM_REGISTRY))
    component.properties = [{ name: "opensesame:resolved", value: resolved }];
  return component;
}

/** One component per npm package version; workspaces and links are ours. */
export function npmComponents(lock) {
  const components = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes("node_modules/") || entry.link || !entry.version)
      continue;
    const next = npmComponent(key, entry);
    const seen = components.get(next.purl);
    if (!seen || SCOPE_RANK[next.scope] > SCOPE_RANK[seen.scope])
      components.set(next.purl, next);
  }
  return [...components.values()];
}

/** The `[[package]]` tables of a Cargo.lock as plain records. */
export function cargoPackages(text) {
  const packages = [];
  for (const block of String(text)
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)) {
    const record = {};
    for (const match of block.matchAll(/^(\w+) = "([^"]*)"\s*$/gm))
      record[match[1]] = match[2];
    packages.push(record);
  }
  return packages;
}

/** One component per crate version; a crate with no source is a workspace member. */
export function cargoComponents(text) {
  const components = new Map();
  for (const crate of cargoPackages(text)) {
    if (!crate.source || !crate.name || !crate.version) continue;
    const purl = `pkg:cargo/${crate.name}@${crate.version}`;
    const component = {
      type: "library",
      "bom-ref": purl,
      name: crate.name,
      version: crate.version,
      purl,
    };
    if (crate.checksum)
      component.hashes = [{ alg: "SHA-256", content: crate.checksum }];
    if (crate.source !== CRATES_IO)
      component.properties = [
        { name: "opensesame:resolved", value: crate.source },
      ];
    components.set(purl, component);
  }
  return [...components.values()];
}

/** A stable RFC 4122 identifier derived from what the document describes. */
function serialNumber(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The CycloneDX document for one source snapshot. */
export function buildSbom({ sourceSha, version, npmLock, cargoLock }) {
  if (!/^[a-f0-9]{40}$/.test(String(sourceSha)))
    throw new Error("SBOM needs the 40-character source commit");
  if (!version) throw new Error("SBOM needs the candidate version");
  const npm = npmComponents(JSON.parse(npmLock));
  const cargo = cargoComponents(cargoLock);
  // An empty side means a lockfile was not parsed, not that nothing is used.
  if (npm.length === 0 || cargo.length === 0)
    throw new Error("SBOM refused: a lockfile produced no components");
  const components = [...npm, ...cargo].sort((a, b) =>
    a.purl < b.purl ? -1 : 1,
  );
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: serialNumber(`${sourceSha}:${version}`),
    version: 1,
    metadata: {
      tools: {
        components: [
          { type: "application", name: "opensesame scripts/release/sbom.mjs" },
        ],
      },
      component: {
        type: "application",
        "bom-ref": `opensesame@${version}`,
        name: "opensesame",
        version,
      },
      properties: [
        { name: "opensesame:source_sha", value: sourceSha },
        {
          name: "opensesame:coverage",
          value:
            "Every package pinned by package-lock.json and Cargo.lock at this commit; a superset of what any one artifact contains.",
        },
      ],
    },
    components,
  };
}

/** Reads one file of the repository at an exact commit, as data. */
export async function fetchAtCommit({ repository, ref, path, token, fetcher }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repository)))
    throw new Error("SBOM needs GITHUB_REPOSITORY as owner/name");
  if (!/^[a-f0-9]{40}$/.test(String(ref)))
    throw new Error("SBOM reads lockfiles only at a 40-character commit");
  const url = `https://api.github.com/repos/${repository}/contents/${path}?ref=${ref}`;
  const response = await (fetcher ?? fetch)(url, {
    headers: {
      accept: "application/vnd.github.raw+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "opensesame-release-sbom",
    },
  });
  // The status is the diagnosis. A response body is never echoed.
  if (!response.ok)
    throw new Error(
      `Could not read ${path} at ${ref}: HTTP ${response.status}`,
    );
  return response.text();
}

async function lockfiles(directory) {
  if (directory)
    return ["package-lock.json", "Cargo.lock"].map((path) =>
      readFileSync(join(directory, path), "utf8"),
    );
  const source = {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.SOURCE_SHA,
    token: process.env.GH_TOKEN,
  };
  return Promise.all([
    fetchAtCommit({ ...source, path: "package-lock.json" }),
    fetchAtCommit({ ...source, path: "Cargo.lock" }),
  ]);
}

async function main(args) {
  const output = args[0];
  const flag = args.indexOf("--directory");
  const directory = flag < 0 ? undefined : args[flag + 1];
  if (!output || output.startsWith("--") || (flag >= 0 && !directory))
    throw new Error("usage: sbom.mjs OUTPUT [--directory CHECKOUT]");
  const [npmLock, cargoLock] = await lockfiles(directory);
  const sbom = buildSbom({
    sourceSha: process.env.SOURCE_SHA,
    version: process.env.VERSION,
    npmLock,
    cargoLock,
  });
  writeFileSync(output, `${JSON.stringify(sbom)}\n`, { flag: "wx" });
  console.log(
    `SBOM: ${sbom.components.length} components for ${sbom.metadata.component.version}`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
