import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  skillFolderHash,
  verifyInstalledSkills,
} from "../dev/verify-agent-skills.mjs";

function put(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

test("only lock-authenticated skills and tracked first-party links remain discoverable", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "verified-skills-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const installed = join(repo, ".agents/skills");
  const quarantine = join(repo, ".agents/quarantine");
  put(repo, "skills/core/SKILL.md", "# Core\n");
  put(repo, ".agents/skills/demo/SKILL.md", "# Demo\n");
  const demoHash = skillFolderHash(join(installed, "demo"));
  put(
    repo,
    "skills-lock.json",
    `${JSON.stringify({ skills: { demo: { computedHash: demoHash } } })}\n`,
  );
  symlinkSync(join(repo, "skills/core"), join(installed, "core"));

  assert.deepEqual(verifyInstalledSkills({ repo, installed, quarantine }), []);

  put(repo, ".agents/skills/demo/SKILL.md", "# Replaced after review\n");
  put(repo, ".agents/skills/unknown/SKILL.md", "# Unknown\n");
  assert.deepEqual(verifyInstalledSkills({ repo, installed, quarantine }), [
    "demo",
    "unknown",
  ]);
  assert.equal(existsSync(join(installed, "demo")), false);
  assert.equal(existsSync(join(installed, "unknown")), false);
  assert.equal(existsSync(join(installed, "core/SKILL.md")), true);
});

test("links inside a catalogued third-party skill cannot bypass its review hash", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "linked-skills-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const installed = join(repo, ".agents/skills");
  put(repo, "skills/core/SKILL.md", "# Core\n");
  put(repo, ".agents/skills/demo/SKILL.md", "# Demo\n");
  const demoHash = skillFolderHash(join(installed, "demo"));
  put(
    repo,
    "skills-lock.json",
    `${JSON.stringify({ skills: { demo: { computedHash: demoHash } } })}\n`,
  );
  put(repo, "outside.sh", "echo changed\n");
  symlinkSync(join(repo, "outside.sh"), join(installed, "demo/run.sh"));

  assert.deepEqual(verifyInstalledSkills({ repo, installed }), ["demo"]);
});
