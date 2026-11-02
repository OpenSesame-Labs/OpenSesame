import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageCliRelease } from "../../../scripts/release/prepare-cli-release.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(join(tmpdir(), "opensesame-installed-cli-"));
const releaseVersion = "0.0.0-alpha.1";
let releaseDir;
try {
  await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
  await writeFile(join(stage, "package.json"), '{"type":"module"}\n');
  const help = execFileSync(
    process.execPath,
    [join(stage, "dist/bin.js"), "--help"],
    {
      encoding: "utf8",
      cwd: stage,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    },
  );
  assert.match(help, /vault retired/);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [join(stage, "dist/bin.js"), "security", "canary", "serve"],
        { encoding: "utf8", cwd: stage, stdio: "pipe" },
      ),
    (error) =>
      error instanceof Error &&
      "stderr" in error &&
      String(error.stderr).includes("requires --pairing and --state"),
  );

  // CD staging writes the published version into package.json beside dist/.
  releaseDir = await stageCliRelease(releaseVersion);
  const manifest = JSON.parse(
    await readFile(join(releaseDir, "package.json"), "utf8"),
  );
  const stagedVersion = String(manifest.version);
  assert.equal(stagedVersion, releaseVersion);
  assert.match(stagedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  const runStaged = (args) =>
    execFileSync(process.execPath, [join(releaseDir, "dist/bin.js"), ...args], {
      encoding: "utf8",
      cwd: releaseDir,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    });
  for (const args of [["--version"], ["-v"], ["version"]]) {
    assert.equal(runStaged(args), `${stagedVersion}\n`);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
  if (releaseDir !== undefined) {
    await rm(releaseDir, { recursive: true, force: true });
  }
}
process.stdout.write(
  "Installed bundled CLI runs with no workspace, tsx, NODE_PATH or development loader.\n",
);
