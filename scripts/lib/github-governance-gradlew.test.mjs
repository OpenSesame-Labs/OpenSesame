// The repository carries no Gradle wrapper binary: `gradlew` is a text
// launcher that delegates to the pinned Gradle on PATH and resolves its own
// location through symlinks back to the Android project.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

it("delegates Gradle through a text launcher with no checked-in wrapper binary", () => {
  const launcher = readFileSync(new URL("gradlew", root), "utf8");
  expect(launcher).toContain("Gradle 8.13");
  expect(launcher).toContain("apps/android/android");
  expect(launcher).toContain("readlink");
  expect(launcher).toContain("pwd -P");
  expect(() =>
    readFileSync(new URL("gradle/wrapper/gradle-wrapper.jar", root)),
  ).toThrow();
});

it("resolves a symlinked gradlew chain back to the Android project", () => {
  const repoRoot = fileURLToPath(root);
  const launcherPath = fileURLToPath(new URL("gradlew", root));
  const dir = mkdtempSync(join(tmpdir(), "gradlew-link-"));
  try {
    const fake = join(dir, "gradle");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  echo 'Gradle 8.13'",
        "  exit 0",
        "fi",
        "printf '%s\\n' \"$@\"",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const nested = join(dir, "bin");
    mkdirSync(nested);
    // Relative hop, then an absolute hop: the chain the wrapper used to walk.
    symlinkSync(launcherPath, join(nested, "hop"));
    const chain = join(dir, "gradlew");
    symlinkSync("bin/hop", chain);
    const env = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
    };
    const chained = spawnSync("sh", [chain, "tasks"], {
      env,
      encoding: "utf8",
    });
    expect(chained.status, chained.stderr).toBe(0);
    expect(chained.stdout).toBe(
      `--project-dir\n${join(repoRoot, "apps/android/android")}\ntasks\n`,
    );
    // A symlinked parent directory must not become APP_HOME either.
    const viaParent = join(dir, "parent");
    symlinkSync(repoRoot, viaParent);
    const parent = spawnSync("sh", [join(viaParent, "gradlew"), "tasks"], {
      env,
      encoding: "utf8",
    });
    expect(parent.status, parent.stderr).toBe(0);
    expect(parent.stdout).toBe(chained.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
