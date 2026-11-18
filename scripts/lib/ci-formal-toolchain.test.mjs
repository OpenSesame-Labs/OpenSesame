import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-formal-toolchain-"));
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "runner"));
  return { directory, log: join(directory, "commands.log") };
}

describe("formal proof toolchain installation", () => {
  it("pins the release archive and rejects a corrupt download before extraction", () => {
    const tools = readFileSync(
      join(root, "scripts/release/deep-tools.sh"),
      "utf8",
    );
    expect(tools).toContain(
      "leanprover/lean4/releases/download/v4.24.0/lean-4.24.0-linux.tar.zst",
    );
    expect(tools).toContain(
      "b14f5e5159219dd1a1956c3b806813319f5e94ccd5bdfd56f54520609a5bb5ec",
    );
    const f = fixture();
    try {
      const bin = join(f.directory, "bin");
      writeFileSync(
        join(bin, "curl"),
        '#!/usr/bin/env bash\nwhile [ "$1" != "-o" ]; do shift; done\nprintf corrupt > "$2"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "tar"),
        '#!/usr/bin/env bash\nprintf extracted > "$COMMAND_LOG"\n',
        { mode: 0o755 },
      );
      const envFile = join(f.directory, "github-env"),
        pathFile = join(f.directory, "github-path");
      const result = spawnSync(
        "bash",
        [join(root, "scripts/release/deep-tools.sh"), "formal-proofs"],
        {
          cwd: f.directory,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: join(f.directory, "runner"),
            COMMAND_LOG: f.log,
            GITHUB_ENV: envFile,
            GITHUB_PATH: pathFile,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(f.log)).toBe(false);
      expect(existsSync(envFile)).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});
