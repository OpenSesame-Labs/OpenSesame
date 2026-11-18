import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("retired installer gives guidance without executing tools or changing files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "skills-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  mkdirSync(join(root, "scripts/dev"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../dev/install-agent-skills.sh", import.meta.url)),
    join(root, "scripts/dev/install-agent-skills.sh"),
  );
  const existing = {
    "skills-lock.json": '{"skills":{"demo":{"source":"example/demo"}}}\n',
    ".codex/hooks.json": '{"user":"keep"}\n',
    ".claude/settings.json": '{"user":"keep"}\n',
    ".agents/skills/demo/SKILL.md": "# Reviewed copy\n",
    ".agents/.skills-currency.json": '{"status":"old"}\n',
  };
  for (const [path, value] of Object.entries(existing)) put(path, value);
  const marker = join(root, "unexpected-tool");
  for (const name of [
    "npx",
    "npm",
    "node",
    "git",
    "curl",
    "wget",
    "skills",
    "impeccable",
    "typeui.sh",
    "timeout",
    "perl",
    "cat",
    "mkdir",
    "rm",
  ]) {
    const path = join(root, "bin", name);
    put(
      `bin/${name}`,
      '#!/bin/sh\nprintf "%s\\n" "$0" >> "$OPENSESAME_SKILL_TOOL_MARKER"\nexit 91\n',
    );
    chmodSync(path, 0o755);
  }
  for (const [args, status] of [
    [[], 1],
    [["--instructions"], 0],
    [["--unknown"], 2],
  ]) {
    const result = spawnSync(
      "/bin/bash",
      ["scripts/dev/install-agent-skills.sh", ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: join(root, "bin"),
          OPENSESAME_SKILL_TOOL_MARKER: marker,
          NODE_AUTH_TOKEN: "synthetic-secret-never-print",
        },
      },
    );
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /synthetic-secret-never-print/,
    );
    if (args[0] !== "--unknown") {
      assert.match(result.stdout, /No skills were installed or updated/);
      assert.match(result.stdout, /immutable revision/);
      assert.match(result.stdout, /disable unreviewed copies/);
    }
  }
  assert.equal(existsSync(marker), false);
  for (const [path, value] of Object.entries(existing)) {
    assert.equal(readFileSync(join(root, path), "utf8"), value, path);
  }
});
