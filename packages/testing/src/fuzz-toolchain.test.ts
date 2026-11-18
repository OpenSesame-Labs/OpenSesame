import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Rust fuzz tooling", () => {
  it("preserves the capability corpus through local and hosted fuzzing", () => {
    execFileSync(
      "python3",
      [join(root, "scripts/fuzz/capability-corpus.test.py")],
      { cwd: root, stdio: "pipe", timeout: 30_000 },
    );
  }, 30_000);

  it.each([
    "scripts/fuzz/fuzz-pr-gate.sh",
    "tests/fuzz/clusterfuzzlite/build.sh",
  ])("pins nightly in %s", (path) => {
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain("cargo +nightly fuzz");
    expect(source).not.toMatch(/cargo fuzz (?:run|build|--version)/u);
  });

  it("defaults the batch to nightly and consistently uses the release's pinned override", () => {
    const source = readFileSync(
      join(root, "scripts/fuzz/fuzz-batch.sh"),
      "utf8",
    );
    expect(source).toContain(
      'TOOLCHAIN="${OPENSESAME_FUZZ_TOOLCHAIN:-nightly}"',
    );
    expect(source).toContain('cargo "+$TOOLCHAIN" fuzz --version');
    expect(source).toContain('cargo "+$TOOLCHAIN" metadata');
    expect(source).toContain('cargo "+$TOOLCHAIN" fuzz run');
    expect(source).not.toMatch(/cargo fuzz (?:run|build|--version)/u);
    const workflow = readFileSync(
      join(root, ".github/workflows/ci-release-checks.yml"),
      "utf8",
    );
    const declared = [
      ...workflow.matchAll(
        /OPENSESAME_FUZZ_TOOLCHAIN: (nightly-\d{4}-\d{2}-\d{2})/gu,
      ),
    ].map((match) => match[1]);
    const toolchain = declared[0];
    expect(toolchain).toBeDefined();
    expect(new Set(declared).size).toBe(1);
    expect(workflow).toContain(
      `install_args: rust[components=miri]@${toolchain}`,
    );
    expect(workflow).toContain(`MIRI_TOOLCHAIN: ${toolchain}`);
  });

  it.each(["scripts/fuzz/fuzz-pr-gate.sh", "scripts/fuzz/fuzz-batch.sh"])(
    "requires a current fuzz lockfile in %s",
    (path) => {
      const source = readFileSync(join(root, path), "utf8");
      expect(source).toContain(
        "--manifest-path tests/fuzz/cargo/Cargo.toml --locked",
      );
    },
  );
});
