import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  CLI_RELEASE_DIST_BUDGET_BYTES,
  assertCliReleaseDistBudget,
  stageCliRelease,
} from "./prepare-cli-release.mjs";

const execFileAsync = promisify(execFile);

async function filesUnder(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

test("stageCliRelease writes a public publish manifest at the planned version", async () => {
  const dist = join(process.cwd(), "packages/cli/dist");
  const bin = join(dist, "bin.js");
  const probe = join(dist, "cd-release-pack-probe");
  await mkdir(probe, { recursive: true });
  let previous;
  try {
    previous = await readFile(bin);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(bin, "// stub\n");
  await writeFile(join(probe, "leaf.js"), "keep\n");
  await writeFile(join(probe, "leaf.js.map"), "{}\n");
  try {
    const releaseDir = await stageCliRelease("0.1.0-nightly.20261102");
    const manifest = JSON.parse(
      await readFile(join(releaseDir, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, "@opensesame-labs/cli");
    assert.equal(manifest.version, "0.1.0-nightly.20261102");
    assert.equal(manifest.bin.opensesame, "dist/bin.js");
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.publishConfig.provenance, true);
    assert.deepEqual(manifest.files, ["dist", "!dist/**/*.map"]);

    const files = await filesUnder(releaseDir);
    assert.equal(
      files.some((path) => path.endsWith(".map")),
      false,
    );
    assert.ok(
      files.some((path) => path.endsWith("cd-release-pack-probe/leaf.js")),
    );
    let distBytes = 0;
    for (const path of files) {
      if (path.includes(`${join(releaseDir, "dist")}/`)) {
        distBytes += (await stat(path)).size;
      }
    }
    assert.ok(distBytes > 0);
    assert.ok(distBytes <= CLI_RELEASE_DIST_BUDGET_BYTES);
    assert.throws(
      () => assertCliReleaseDistBudget(CLI_RELEASE_DIST_BUDGET_BYTES + 1),
      new RegExp(`over ${CLI_RELEASE_DIST_BUDGET_BYTES}`),
    );
    assert.throws(() => assertCliReleaseDistBudget(1.5), /not a byte count/);

    await writeFile(
      join(releaseDir, "dist/cd-release-pack-probe/sneak.js.map"),
      "{}\n",
    );
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: releaseDir },
    );
    const packed = JSON.parse(stdout);
    const entry = Array.isArray(packed)
      ? packed.find((item) => item.name === "@opensesame-labs/cli")
      : packed;
    assert.ok(entry);
    const paths = entry.files.map((file) => file.path);
    assert.equal(
      paths.some((path) => path.endsWith(".map")),
      false,
    );
    assert.ok(paths.includes("dist/bin.js"));
    assert.ok(paths.includes("dist/cd-release-pack-probe/leaf.js"));
    assert.equal(
      paths.includes("dist/cd-release-pack-probe/sneak.js.map"),
      false,
    );
  } finally {
    await rm(probe, { recursive: true, force: true });
    if (previous === undefined) await rm(bin, { force: true });
    else await writeFile(bin, previous);
  }
});
