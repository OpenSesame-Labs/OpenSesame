import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { BUILD_PREDICATE } from "./provenance.mjs";
import {
  SBOM_PREDICATE,
  buildSbom,
  cargoComponents,
  cargoPackages,
  fetchAtCommit,
  npmComponents,
} from "./sbom.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = "0123456789abcdef0123456789abcdef01234567";
const sha512 = (hex) => `sha512-${Buffer.from(hex, "hex").toString("base64")}`;

const npmLock = {
  packages: {
    "": { name: "opensesame" },
    "packages/app-core": { name: "@opensesame/app-core", version: "0.1.0" },
    "node_modules/@opensesame/app-core": {
      resolved: "packages/app-core",
      link: true,
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: sha512("ab12"),
    },
    "node_modules/@scope/tool": { version: "2.0.0", dev: true },
    "apps/pages/node_modules/@scope/tool": { version: "2.0.0" },
    "node_modules/alias": {
      name: "@real/name",
      version: "3.1.4",
      optional: true,
    },
    "node_modules/patched": {
      version: "1.0.0",
      resolved: "file:patches/vendor/patched-1.0.0.tgz",
      integrity: sha512("cd34"),
    },
  },
};

const cargoLock = `# generated
version = 4

[[package]]
name = "aead"
version = "0.5.2"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "d122413f"
dependencies = [
 "crypto-common",
]

[[package]]
name = "age"
version = "0.11.1"
source = "git+https://github.com/str4d/rage?rev=b5b68c4#b5b68c4"

[[package]]
name = "opensesame-gateway"
version = "0.1.0"
dependencies = [
 "aead",
]
`;

test("npm components skip workspaces and links and name scoped and aliased packages", () => {
  const components = npmComponents(npmLock);
  assert.deepEqual(components.map((c) => c.purl).sort(), [
    "pkg:npm/%40real/name@3.1.4",
    "pkg:npm/%40scope/tool@2.0.0",
    "pkg:npm/left-pad@1.3.0",
    "pkg:npm/patched@1.0.0",
  ]);
  const byPurl = Object.fromEntries(components.map((c) => [c.purl, c]));
  assert.equal(byPurl["pkg:npm/%40real/name@3.1.4"].name, "@real/name");
  assert.equal(byPurl["pkg:npm/%40real/name@3.1.4"].scope, "optional");
  assert.deepEqual(byPurl["pkg:npm/left-pad@1.3.0"].hashes, [
    { alg: "SHA-512", content: "ab12" },
  ]);
  assert.equal(byPurl["pkg:npm/left-pad@1.3.0"].properties, undefined);
});

test("a package used at runtime anywhere is not reported as development-only", () => {
  const tool = npmComponents(npmLock).find((c) => c.name === "@scope/tool");
  assert.equal(tool.scope, "required");
  const onlyDev = npmComponents({
    packages: { "node_modules/x": { version: "1.0.0", dev: true } },
  });
  assert.equal(onlyDev[0].scope, "excluded");
});

test("a package installed from somewhere other than the registry says where", () => {
  const patched = npmComponents(npmLock).find((c) => c.name === "patched");
  assert.deepEqual(patched.properties, [
    {
      name: "opensesame:resolved",
      value: "file:patches/vendor/patched-1.0.0.tgz",
    },
  ]);
});

test("cargo components skip workspace members and record git sources", () => {
  assert.equal(cargoPackages(cargoLock).length, 3);
  assert.deepEqual(cargoComponents(cargoLock), [
    {
      type: "library",
      "bom-ref": "pkg:cargo/aead@0.5.2",
      name: "aead",
      version: "0.5.2",
      purl: "pkg:cargo/aead@0.5.2",
      hashes: [{ alg: "SHA-256", content: "d122413f" }],
    },
    {
      type: "library",
      "bom-ref": "pkg:cargo/age@0.11.1",
      name: "age",
      version: "0.11.1",
      purl: "pkg:cargo/age@0.11.1",
      properties: [
        {
          name: "opensesame:resolved",
          value: "git+https://github.com/str4d/rage?rev=b5b68c4#b5b68c4",
        },
      ],
    },
  ]);
});

function build(overrides = {}) {
  return buildSbom({
    sourceSha: sha,
    version: "1.2.3",
    npmLock: JSON.stringify(npmLock),
    cargoLock,
    ...overrides,
  });
}

test("the document is valid CycloneDX in shape, sorted and reproducible", () => {
  const sbom = build();
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.match(
    sbom.serialNumber,
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(sbom.metadata.component.version, "1.2.3");
  assert.deepEqual(sbom.metadata.properties[0], {
    name: "opensesame:source_sha",
    value: sha,
  });
  const purls = sbom.components.map((c) => c.purl);
  assert.deepEqual(purls, [...purls].sort());
  assert.equal(new Set(purls).size, purls.length);
  for (const component of sbom.components)
    assert.equal(component["bom-ref"], component.purl);
  assert.equal(JSON.stringify(build()), JSON.stringify(sbom));
  assert.equal(JSON.stringify(sbom).includes("timestamp"), false);
  assert.notEqual(build({ version: "1.2.4" }).serialNumber, sbom.serialNumber);
});

test("an unparsed or empty lockfile is refused, not reported as no dependencies", () => {
  assert.throws(() => build({ cargoLock: "version = 4\n" }), /no components/);
  assert.throws(() => build({ npmLock: '{"packages":{}}' }), /no components/);
  assert.throws(() => build({ npmLock: "not json" }), SyntaxError);
  assert.throws(() => build({ sourceSha: "main" }), /40-character/);
  assert.throws(() => build({ version: "" }), /version/);
});

test("the repository's own lockfiles produce every pinned package once", () => {
  const lockText = readFileSync(join(root, "package-lock.json"), "utf8");
  const cargoText = readFileSync(join(root, "Cargo.lock"), "utf8");
  const sbom = build({ npmLock: lockText, cargoLock: cargoText });
  const lock = JSON.parse(lockText);
  const npmExpected = new Set(
    Object.entries(lock.packages)
      .filter(([key, entry]) => key.includes("node_modules/") && !entry.link)
      .map(([key, entry]) => {
        const name =
          entry.name ?? key.slice(key.lastIndexOf("node_modules/") + 13);
        return `${name}@${entry.version}`;
      }),
  );
  const crates = [...cargoText.matchAll(/^source = /gm)].length;
  const npm = sbom.components.filter((c) => c.purl.startsWith("pkg:npm/"));
  const cargo = sbom.components.filter((c) => c.purl.startsWith("pkg:cargo/"));
  assert.equal(npm.length, npmExpected.size);
  assert.ok(npm.length > 1000);
  assert.ok(cargo.length > 500 && cargo.length <= crates);
  assert.ok(npm.every((c) => c.hashes?.length > 0));
  assert.ok(
    cargo.some((c) => c.properties),
    "git-sourced crates are marked",
  );
});

test("lockfiles are fetched by exact commit and a failure names only the status", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, text: async () => "contents" };
  };
  const source = { repository: "owner/name", ref: sha, token: "t", fetcher };
  assert.equal(
    await fetchAtCommit({ ...source, path: "Cargo.lock" }),
    "contents",
  );
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/owner/name/contents/Cargo.lock?ref=${sha}`,
  );
  assert.equal(calls[0].init.headers.accept, "application/vnd.github.raw+json");
  await assert.rejects(
    fetchAtCommit({
      ...source,
      path: "Cargo.lock",
      fetcher: async () => ({
        ok: false,
        status: 404,
        text: async () => "secret body",
      }),
    }),
    (error) =>
      /HTTP 404/.test(error.message) && !error.message.includes("secret body"),
  );
  await assert.rejects(
    fetchAtCommit({ ...source, ref: "main" }),
    /40-character/,
  );
  await assert.rejects(
    fetchAtCommit({ ...source, repository: "bad" }),
    /owner\/name/,
  );
});

test("the command writes one document from a checkout and refuses to overwrite", () => {
  const work = mkdtempSync(join(tmpdir(), "opensesame-sbom-"));
  try {
    const output = join(work, "sbom.cdx.json");
    const run = () =>
      execFileSync(
        process.execPath,
        [join(root, "scripts/release/sbom.mjs"), output, "--directory", root],
        {
          encoding: "utf8",
          env: { ...process.env, SOURCE_SHA: sha, VERSION: "9.9.9" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    assert.match(run(), /^SBOM: \d+ components for 9\.9\.9\n$/);
    const sbom = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(sbom.metadata.component.version, "9.9.9");
    assert.throws(run, /EEXIST/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the candidate build signs the inventory for the artifacts it built", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/candidate-build.yml"), "utf8"),
  );
  const job = workflow.jobs.manifest;
  const steps = job.steps;
  const attested = steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/attest@"),
  );
  assert.deepEqual(
    attested.map((step) => step.with["predicate-type"]),
    [BUILD_PREDICATE, SBOM_PREDICATE],
  );
  // Same subjects as the build attestation: the artifact digests.
  assert.equal(
    attested[1].with["subject-checksums"],
    attested[0].with["subject-checksums"],
  );
  assert.equal(attested[1].with["predicate-path"], "sbom.cdx.json");
  const generate = steps[steps.indexOf(attested[1]) - 1];
  assert.equal(
    generate.run,
    "node .ci-control/scripts/release/sbom.mjs sbom.cdx.json",
  );
  // Both steps are required: neither may fail quietly or be skipped.
  for (const step of [generate, attested[1]]) {
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, undefined);
  }
  // The generator reads these from the job; it takes nothing from the candidate.
  for (const name of ["SOURCE_SHA", "VERSION", "GH_TOKEN"])
    assert.ok(job.env[name], name);
  // The job checks out controller code only, never the candidate's source.
  const checkouts = steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.ref, "${{ github.workflow_sha }}");
});

test("promotion still verifies the build predicate, which the inventory cannot satisfy", () => {
  assert.notEqual(SBOM_PREDICATE, BUILD_PREDICATE);
  const provenance = readFileSync(
    join(root, "scripts/release/provenance.mjs"),
    "utf8",
  );
  assert.match(provenance, /"--predicate-type",\s*BUILD_PREDICATE/);
});
