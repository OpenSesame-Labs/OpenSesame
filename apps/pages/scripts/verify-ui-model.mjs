import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedDigest =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

/** Every top-level model is checked: missing or orphaned configurations fail. */
export function discoverModels(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      (entry.name.endsWith(".tla") || entry.name.endsWith(".cfg")) &&
      !entry.isFile()
    ) {
      throw new Error(`Expected a regular model file: ${entry.name}`);
    }
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const models = files.filter((file) => file.endsWith(".tla")).sort();
  const configs = files.filter((file) => file.endsWith(".cfg")).sort();
  if (models.length === 0 || configs.length === 0) {
    throw new Error(
      "Model directory must contain at least one model and configuration",
    );
  }
  const names = new Set(files);
  for (const model of models) {
    if (!names.has(`${model.slice(0, -4)}.cfg`)) {
      throw new Error(`Missing configuration for ${model}`);
    }
  }
  for (const config of configs) {
    if (!names.has(`${config.slice(0, -4)}.tla`)) {
      throw new Error(`Missing model for ${config}`);
    }
  }
  return models;
}

/** Run all models, stopping at the first error or counterexample. */
export function checkModels(directory, jar, metadata, run = spawnSync) {
  const models = discoverModels(directory);
  for (const model of models) {
    console.log(`Checking model: ${model}`);
    const result = run(
      "java",
      [
        "-XX:+UseParallelGC",
        "-cp",
        resolve(jar),
        "tlc2.TLC",
        "-metadir",
        join(metadata, model.slice(0, -4)),
        "-config",
        `${model.slice(0, -4)}.cfg`,
        model,
      ],
      { cwd: directory, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `TLC failed for ${model} (exit ${result.status ?? "unknown"})`,
      );
    }
  }
  console.log(`Checked ${models.length} model(s) in ${directory}`);
}

/** Each declared domain needs its own nonempty, completely paired model set. */
export function checkModelDirectories(
  directories,
  jar,
  metadata,
  run = spawnSync,
) {
  if (directories.length === 0)
    throw new Error("No model directories declared");
  for (const directory of directories) {
    checkModels(directory, jar, join(metadata, basename(directory)), run);
  }
}

export function validateJar(jar) {
  if (!jar)
    throw new Error(
      "Set TLA2TOOLS_JAR to the pinned TLC 1.7.4 jar; see spec/ui-behavior/README.md",
    );
  const digest = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (digest !== expectedDigest) {
    throw new Error(
      "TLA2TOOLS_JAR does not match the reviewed TLC 1.7.4 release",
    );
  }
}

function main() {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const spec = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../spec",
  );
  const metadata = mkdtempSync(join(tmpdir(), "opensesame-tlc-"));
  try {
    checkModelDirectories(
      [join(spec, "ui-behavior"), join(spec, "auth-verification")],
      jar,
      metadata,
    );
  } finally {
    rmSync(metadata, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
