import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { prepareNativeAudit } from "./prepare-distribution.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("a cold audit publishes downloads from private scratch to a separate cache filesystem", async (t) => {
  const repository = await mkdtemp(
    join(dirname(resolve(process.cwd())), ".native-audit-repository-"),
  );
  const reports = await mkdtemp(join(tmpdir(), "native-audit-reports-"));
  t.after(async () => {
    await rm(repository, { recursive: true, force: true });
    await rm(reports, { recursive: true, force: true });
  });
  const here = join(repository, "tools/pwa-tailscale-native-http");
  const binaries = join(reports, "binaries");
  await mkdir(here, { recursive: true });
  await mkdir(binaries);
  const sourceArchive = "fixture source archive";
  const compilerArchive = "fixture compiler archive";
  const curl = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nconst output=args[args.indexOf('--output')+1];\nconst value=args.at(-1).endsWith('/source') ? ${JSON.stringify(sourceArchive)} : ${JSON.stringify(compilerArchive)};\nwriteFileSync(output,value);\n`;
  await writeFile(join(binaries, "curl"), curl);
  await chmod(join(binaries, "curl"), 0o700);
  const builder = `import {mkdir,writeFile} from 'node:fs/promises';\nimport {join} from 'node:path';\nconst output=process.argv[4];\nawait mkdir(output,{recursive:true});\nawait writeFile(join(output,'native-audit.json'),JSON.stringify({compilerVersion:'go1.27.3',affectedImportedPackages:0,packages:3,modules:3,moduleOnlyAdvisories:[]}));\n`;
  await writeFile(join(here, "build.mjs"), builder);
  await writeFile(join(here, "exit-route.patch"), "fixture patch");
  const helper = { path: "build.mjs", sha256: hash(builder) };
  const patch = { path: "exit-route.patch", sha256: hash("fixture patch") };
  const pins = {
    source: {
      archiveURL: "https://example.invalid/source",
      archiveSha256: hash(sourceArchive),
    },
    compiler: {
      archiveURL: "https://example.invalid/compiler",
      archiveSha256: hash(compilerArchive),
      version: "go1.27.3",
    },
    nativeHttp: { files: [] },
    nativeBridge: { files: [] },
    nativeNode: { files: [], stagingHelper: helper },
    toolchainSelection: { files: [] },
    privateLogging: { files: [] },
    publicTrust: { files: [] },
    nativeSSH: { patch, stagingHelper: helper },
    codeqlWasmSecurity: { patch, stagingHelper: helper, patchTargets: [] },
    composition: { files: [] },
    patch: { sha256: patch.sha256 },
  };
  const source = JSON.stringify(pins);
  await writeFile(join(here, "source.json"), source);
  const initialPath = process.env.PATH;
  process.env.PATH = `${binaries}${delimiter}${initialPath ?? ""}`;
  try {
    const result = await prepareNativeAudit(repository, hash(source), reports);
    assert.equal(result.affectedImportedPackages, 0);
  } finally {
    if (initialPath === undefined) delete process.env.PATH;
    else process.env.PATH = initialPath;
  }
  const archives = join(
    repository,
    ".cache/pwa-tailscale-native-http/archives",
  );
  assert.equal(
    await readFile(join(archives, `${hash(sourceArchive)}.tar.gz`), "utf8"),
    sourceArchive,
  );
  assert.equal(
    await readFile(join(archives, `${hash(compilerArchive)}.tar.gz`), "utf8"),
    compilerArchive,
  );
  assert.equal((await readdir(archives)).length, 2);
  const works = join(reports, "native-go/work");
  const [work] = await readdir(works);
  await assert.rejects(stat(join(works, work, "source.download")), {
    code: "ENOENT",
  });
  await assert.rejects(stat(join(works, work, "compiler.download")), {
    code: "ENOENT",
  });
  // Report whether this host exercised a real cross-device copy. The same test
  // remains useful on hosts where /tmp and the workspace share one filesystem.
  if ((await stat(reports)).dev !== (await stat(repository)).dev)
    t.diagnostic(
      "private audit scratch and the archive cache are on different filesystems",
    );
});
