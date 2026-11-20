import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const PATCHED = Object.freeze({
  "glob@10.5.0": Object.freeze({
    advisory: "GHSA-3g3m-2fjr-6pw4",
    patch: "patches/glob@10.5.0.patch",
    patchSha256:
      "0cce39fd9b90f4011d07181f5bb47a17d2b10d7c0d0f191e58e83ee5114546d4",
    tarball: "patches/vendor/glob-10.5.0.tgz",
    tarballIntegrity:
      "sha512-IHvZPurl6zvJ1L0QepSqmcXP6X1UTsDMwYEiVuxral9CDQoMm9CvsQFyB5A6SptuCd8K5Nrm6vQpYM38zgLyEA==",
    upstreamIntegrity:
      "sha512-DfXN8DfhJ7NH3Oe7cFmu3NCu1wKbkReJ8TorzSAFbSKrlNaQSKfIzqYqVY8zlbs2NLBbWpRiU52GX2PbaBVNkg==",
    upstreamFileMapSha256:
      "c2a363194438a851d193a8a167702d51480e9547ae87bf30439875269cf1aeb2",
    rootDependency: "glob10-patched",
    override: "glob@^10.0.0",
  }),
  "glob@11.1.0": Object.freeze({
    advisory: "GHSA-3g3m-2fjr-6pw4",
    patch: "patches/glob@11.1.0.patch",
    patchSha256:
      "0cce39fd9b90f4011d07181f5bb47a17d2b10d7c0d0f191e58e83ee5114546d4",
    tarball: "patches/vendor/glob-11.1.0.tgz",
    tarballIntegrity:
      "sha512-BXaDJvBKQd7ZAGZHRswHGHzRCdlRX1BTr9D02PiGjWEVkRrdLioWW8Oe7HbwimL57J3gwKe+lRR3wG/lH+szwQ==",
    upstreamIntegrity:
      "sha512-vuNwKSaKiqm7g0THUBu2x7ckSs3XJLXE+2ssL7/MfTGPLLcrJQ/4Uq1CjPTtO5cCIiRxqvN6Twy1qOwhL0Xjcw==",
    upstreamFileMapSha256:
      "4816a93773653820c70e024a417ea6f26eb84c912a1a2e858fe5d614a28c63ab",
    rootDependency: "glob11-patched",
    override: "glob@^11.0.1",
  }),
  "minimatch@9.0.9": Object.freeze({
    advisory: "GHSA-g3hv-75wg-m249",
    patch: "patches/minimatch@9.0.9.patch",
    patchSha256:
      "1ab0efc7db3ebc33e05990e324aa50015517fe1d7b2c5b6d8213d0d452ea5f44",
    tarball: "patches/vendor/minimatch-9.0.9.tgz",
    tarballIntegrity:
      "sha512-gzzVMhFun/WXS0/+asDjkV7WuRgkIWY+LF5Y+hr4SMWbk+Qzmd1B4aVdVknjDJkuR8S1PpMSMVYMfuowuNyjmg==",
    upstreamIntegrity:
      "sha512-OBwBN9AL4dqmETlpS2zasx+vTeWclWzkblfZk7KTA5j3jeOONz/tRCnZomUyvNg83wL5Zv9Ss6HMJXAgL8R2Yg==",
    upstreamFileMapSha256:
      "4b237892bc30463c10e867a0f053defd60feaf4d131fed9a85e4e6c04e0cc661",
    rootDependency: "minimatch9-patched",
    override: "minimatch@^9.0.4",
  }),
});

const PUBLISHED = Object.freeze({});

const REGRESSIONS = Object.freeze({
  "scripts/security/dependency-override-upgrade.test.mjs":
    "6164b37b6f93d0392fa80e13c3cd4cf8fc116f7e943d20db47dd7ff67da0f667",
  "scripts/security/glob-override-upgrade.test.mjs":
    "21284c2b686376ca469d60626a00d7f33056d83515267f5e35eec362dd8f0520",
  "scripts/security/removed-dependencies.test.mjs":
    "64d2015c6b64e76b140799c7f7cd51afb2d885d92df909418b8151f14b980dd1",
  "scripts/security/picomatch-backport.test.mjs":
    "17796faf39393ae5c27e73b1771b5d1d7b22680ba9b376cb5c49cf9dde8c85b6",
  "scripts/security/patched-dependencies.mjs":
    "1bd90d0ef5c21914f653a3dab7a3957df806983f9fe5f7fe9e4c1ff76c8a34ad",
});

function fail(message) {
  throw new Error(message);
}

function safeFile(root, relative) {
  const path = resolve(root, relative);
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    !path.startsWith(`${root}/`)
  )
    fail(`unsafe attestation path: ${relative}`);
  return path;
}

function digest(path, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function sri(path) {
  return `sha512-${digest(path, "sha512", "base64")}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function lockName(location, entry) {
  if (isString(entry.name)) return entry.name;
  const marker = "node_modules/";
  const at = location.lastIndexOf(marker);
  return at === -1 ? undefined : location.slice(at + marker.length);
}

function sourceIsRootLock(root, source) {
  if (!isString(source) || basename(source) !== "package-lock.json")
    return false;
  const path = isAbsolute(source) ? source : resolve(root, source);
  return resolve(path) === join(root, "package-lock.json");
}

function exactManifestEntry(actual, expected) {
  const fields = [
    "patch",
    "tarball",
    "upstreamIntegrity",
    "upstreamFileMapSha256",
    "rootDependency",
    "override",
  ];
  return (
    actual &&
    Object.keys(actual).sort().join("\0") === fields.sort().join("\0") &&
    fields.every((field) => actual[field] === expected[field])
  );
}

function normalizedCveLiteFindings(report, root) {
  if (
    !report ||
    !Array.isArray(report.findings) ||
    report.findingCount !== report.findings.length
  )
    fail("invalid cve-lite findings");
  return report.findings.flatMap((finding) => {
    if (!finding || !Array.isArray(finding.vulnerabilities))
      fail("invalid cve-lite finding");
    return finding.vulnerabilities.map((vulnerability) => ({
      id: vulnerability?.id,
      ecosystem: "npm",
      package: finding.package,
      version: finding.version,
      source: join(root, "package-lock.json"),
    }));
  });
}

function validateFindings(root, findings) {
  const seen = new Set();
  for (const finding of findings) {
    if (finding?.ecosystem !== "npm") fail("unattested advisory finding");
    const tuple = `${finding.package}@${finding.version}`;
    const proof = PATCHED[tuple] ?? PUBLISHED[tuple];
    const identity = `${finding.id}\0${tuple}`;
    if (
      !proof ||
      proof.advisory !== finding.id ||
      seen.has(identity) ||
      !sourceIsRootLock(root, finding.source)
    )
      fail(
        `unattested advisory tuple: ${finding.id ?? "?"} ${tuple} from ${finding.source ?? "?"}`,
      );
    seen.add(identity);
  }
  const expected = new Set(
    [...Object.entries(PATCHED), ...Object.entries(PUBLISHED)].map(
      ([tuple, proof]) => `${proof.advisory}\0${tuple}`,
    ),
  );
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id)))
    fail("incomplete exact repaired advisory findings");
  return seen;
}

function dependencyEvidence(root) {
  const evidence = {
    manifest: readJson(safeFile(root, "package.json")),
    lock: readJson(safeFile(root, "package-lock.json")),
    vendor: readJson(safeFile(root, "patches/vendor/manifest.json")),
  };
  if (
    evidence.lock.lockfileVersion !== 3 ||
    !evidence.lock.packages ||
    !evidence.vendor.vendored
  )
    fail("unexpected dependency attestation manifests");
  return evidence;
}

function tupleParts(tuple) {
  const at = tuple.lastIndexOf("@");
  return [tuple.slice(0, at), tuple.slice(at + 1)];
}

function lockOccurrences(lock, tuple) {
  const [name, version] = tupleParts(tuple);
  return Object.entries(lock.packages).filter(
    ([location, entry]) =>
      lockName(location, entry) === name && entry.version === version,
  );
}

function attestPatchedFiles(root, vendor, tuple, proof) {
  if (!exactManifestEntry(vendor.vendored[tuple], proof))
    fail(`${tuple}: vendored provenance drift`);
  if (digest(safeFile(root, proof.patch), "sha256") !== proof.patchSha256)
    fail(`${tuple}: patch drift`);
  if (sri(safeFile(root, proof.tarball)) !== proof.tarballIntegrity)
    fail(`${tuple}: tarball drift`);
}

function attestRootAlias(manifest, lock, tuple, proof) {
  const [name, version] = tupleParts(tuple);
  const spec = `file:${proof.tarball}`;
  if (
    manifest.devDependencies?.[proof.rootDependency] !== spec ||
    manifest.overrides?.[proof.override] !== `$${proof.rootDependency}` ||
    lock.packages[""]?.devDependencies?.[proof.rootDependency] !== spec
  )
    fail(`${tuple}: root alias or override range drift`);
  const alias = lock.packages[`node_modules/${proof.rootDependency}`];
  if (
    !alias ||
    alias.name !== name ||
    alias.version !== version ||
    alias.resolved !== spec ||
    alias.integrity !== proof.tarballIntegrity ||
    alias.link === true
  )
    fail(`${tuple}: missing or unverified root alias occurrence`);
  return spec;
}

function attestPatchedOccurrences(lock, tuple, proof, spec) {
  const occurrences = lockOccurrences(lock, tuple);
  if (occurrences.length === 0) fail(`${tuple}: missing lock occurrence`);
  for (const [location, entry] of occurrences) {
    if (
      entry.resolved !== spec ||
      entry.integrity !== proof.tarballIntegrity ||
      entry.link === true
    )
      fail(`${tuple}: unverified lock occurrence ${location}`);
  }
}

function attestPatched(root, evidence, tuple, proof) {
  attestPatchedFiles(root, evidence.vendor, tuple, proof);
  const spec = attestRootAlias(evidence.manifest, evidence.lock, tuple, proof);
  attestPatchedOccurrences(evidence.lock, tuple, proof, spec);
}

function attestPublished(manifest, lock, tuple, proof) {
  for (const [range, pinned] of Object.entries(proof.overrides))
    if (manifest.overrides?.[range] !== pinned)
      fail(`${tuple}: override range drift`);
  const occurrences = lockOccurrences(lock, tuple);
  if (occurrences.length === 0) fail(`${tuple}: missing lock occurrence`);
  for (const [location, entry] of occurrences)
    if (
      entry.resolved !== proof.resolved ||
      entry.integrity !== proof.integrity ||
      entry.link === true
    )
      fail(`${tuple}: unverified lock occurrence ${location}`);
}

function verifyRegressions(root, execute) {
  for (const [file, expected] of Object.entries(REGRESSIONS))
    if (digest(safeFile(root, file), "sha256") !== expected)
      fail(`named behavior regression drift: ${file}`);
  for (const tuple of Object.keys(PATCHED))
    execute(
      process.execPath,
      [
        join(root, "scripts/security/patched-dependencies.mjs"),
        "verify-offline",
        tuple,
      ],
      { cwd: root, stdio: "pipe", encoding: "utf8" },
    );
  execute(
    process.execPath,
    [
      "--test",
      ...Object.keys(REGRESSIONS).filter((path) => path.endsWith(".test.mjs")),
    ],
    { cwd: root, stdio: "pipe", encoding: "utf8" },
  );
}

export function attestRepairedFindings(root, findings, options = {}) {
  root = realpathSync(root);
  if (!Array.isArray(findings)) fail("Expected a findings array");
  if (findings.length === 0) return { count: 0, tuples: [] };
  const seen = validateFindings(root, findings);
  const evidence = dependencyEvidence(root);

  for (const [tuple, proof] of Object.entries(PATCHED))
    attestPatched(root, evidence, tuple, proof);
  for (const [tuple, proof] of Object.entries(PUBLISHED))
    attestPublished(evidence.manifest, evidence.lock, tuple, proof);
  const execute = options.execute ?? execFileSync;
  verifyRegressions(root, execute);
  return { count: findings.length, tuples: [...seen].sort() };
}

export function main(argv) {
  try {
    if (argv.length !== 1 && argv.length !== 3)
      fail(
        "Expected one findings file, optionally followed by --attest-repaired ROOT",
      );
    const report = readJson(argv[0]);
    if (argv.length === 1) {
      if (!Array.isArray(report)) fail("Expected a findings array");
      if (report.length !== 0)
        fail(`Reported vulnerabilities: ${JSON.stringify(report)}`);
      console.log("osv-scanner gate: CLEAN (no findings)");
      return 0;
    }
    if (argv[1] !== "--attest-repaired") fail("Unknown advisory gate mode");
    const root = realpathSync(argv[2]);
    const findings = Array.isArray(report)
      ? report
      : normalizedCveLiteFindings(report, root);
    const result = attestRepairedFindings(root, findings);
    console.log(
      result.count === 0
        ? "osv-scanner gate: CLEAN (no findings)"
        : `osv-scanner gate: CLEAN (${result.count} exact repaired findings attested; raw findings retained)`,
    );
    return 0;
  } catch (error) {
    console.error(`osv-scanner gate: FAIL (${error.message})`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
