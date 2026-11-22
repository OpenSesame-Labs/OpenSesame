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
import { skillTreeHashV2 } from "../dev/verify-agent-skills.mjs";

test("verification runs offline and quarantines content changed since review", (t) => {
  const root = mkdtempSync(join(tmpdir(), "skills-install-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  mkdirSync(join(root, "scripts/dev"), { recursive: true });
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../dev/install-agent-skills.sh", import.meta.url)),
    join(root, "scripts/dev/install-agent-skills.sh"),
  );
  copyFileSync(
    fileURLToPath(new URL("../dev/verify-agent-skills.mjs", import.meta.url)),
    join(root, "scripts/dev/verify-agent-skills.mjs"),
  );
  copyFileSync(
    fileURLToPath(new URL("../lib/json-boundary.mjs", import.meta.url)),
    join(root, "scripts/lib/json-boundary.mjs"),
  );
  put("scripts/dev/sync-agent-skills.mjs", "");
  put("skills/core/SKILL.md", "# Core\n");
  put(".agents/skills/demo/SKILL.md", "# Demo\n");
  const treeHashV2 = skillTreeHashV2(join(root, ".agents/skills/demo"));
  put(
    "skills-lock.json",
    `${JSON.stringify({ integrity: { algorithm: "opensesame-skill-tree-v2" }, skills: { demo: { treeHashV2, source: "example/demo" } } })}\n`,
  );
  put(".codex/hooks.json", "{}\n");
  put(".claude/settings.json", "{}\n");
  put(".gitignore", ".agents/\nbin/\nglobal.gitconfig\n");
  const gitEnv = { ...process.env };
  put("bin/git", "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin/git"), 0o755);
  put("bin/npx", "#!/bin/sh\ntouch bin/npx-invoked\nexit 1\n");
  chmodSync(join(root, "bin/npx"), 0o755);
  const run = (...args) => {
    const result = spawnSync(
      "bash",
      ["scripts/dev/install-agent-skills.sh", ...args],
      {
        cwd: root,
        env: { ...gitEnv, PATH: `${join(root, "bin")}:${process.env.PATH}` },
        stdio: "pipe",
      },
    );
    assert.equal(result.status, 0, result.stderr?.toString());
  };
  const status = () =>
    JSON.parse(
      readFileSync(join(root, ".agents/.skills-currency.json"), "utf8"),
    ).status;
  run();
  assert.equal(status(), "ok");
  assert.equal(existsSync(join(root, "bin/npx-invoked")), false);

  put(".agents/skills/demo/SKILL.md", "# Changed without review\n");
  run();
  assert.equal(status(), "degraded");
  assert.equal(existsSync(join(root, ".agents/skills/demo")), false);
  assert.equal(existsSync(join(root, ".agents/quarantine")), true);
  assert.equal(existsSync(join(root, "bin/npx-invoked")), false);

  run("--refresh");
  assert.equal(status(), "degraded");
  assert.equal(existsSync(join(root, "bin/npx-invoked")), true);
});
