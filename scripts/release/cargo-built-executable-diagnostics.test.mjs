import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "../lib/ci-changed-areas.mjs";

const root = repoRootFromHere();
const manifest = join(root, "Cargo.toml");
const resolver = join(import.meta.dirname, "cargo-built-executable.mjs");

const hasCargo =
  existsSync(manifest) &&
  spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

describe("cargo build stderr diagnostics (native-untrusted resolve_bin)", () => {
  it.skipIf(!hasCargo)(
    "surfaces rustc errors on stderr when the bin name is invalid",
    () => {
      const build = spawnSync(
        "cargo",
        [
          "build",
          "--locked",
          "-p",
          "opensesame-cli",
          "--bin",
          "__opensesame_ci_invalid_bin__",
          "--message-format=json-render-diagnostics",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(build.status).not.toBe(0);
      const combined = `${build.stderr}\n${build.stdout}`;
      expect(combined).toMatch(/error/i);
    },
  );

  it.skipIf(!hasCargo)(
    "keeps stderr visible while piping stdout JSON through the resolver",
    () => {
      const build = spawnSync(
        "cargo",
        [
          "build",
          "--locked",
          "-p",
          "opensesame-cli",
          "--bin",
          "__opensesame_ci_invalid_bin__",
          "--message-format=json-render-diagnostics",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(build.status).not.toBe(0);
      expect(build.stderr).toMatch(/error/i);

      const resolve = spawnSync(process.execPath, [resolver, "opensesame"], {
        input: build.stdout,
        encoding: "utf8",
      });
      expect(resolve.status).not.toBe(0);
    },
  );
});
