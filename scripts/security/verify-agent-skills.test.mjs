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
import { fileURLToPath } from "node:url";
import {
  skillTreeHashV2,
  verifyInstalledSkills,
} from "../dev/verify-agent-skills.mjs";

function put(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function lockFor(skills) {
  return `${JSON.stringify({ integrity: { algorithm: "opensesame-skill-tree-v2" }, skills })}\n`;
}

const HERE = dirname(fileURLToPath(import.meta.url));

test("the framed digest matches a reviewed real catalogue tree", () => {
  assert.equal(
    skillTreeHashV2(join(HERE, "fixtures/catalogued-site-md")),
    "61bb55bf50398e946ccc7b8d125390b7294d5be08df67e3464e0611e80b98850",
  );
});

test("only lock-authenticated skills and tracked first-party links remain discoverable", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "verified-skills-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const installed = join(repo, ".agents/skills");
  const quarantine = join(repo, ".agents/quarantine");
  put(repo, "skills/core/SKILL.md", "# Core\n");
  put(repo, ".agents/skills/demo/SKILL.md", "# Demo\n");
  const demoHash = skillTreeHashV2(join(installed, "demo"));
  put(repo, "skills-lock.json", lockFor({ demo: { treeHashV2: demoHash } }));
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
  const demoHash = skillTreeHashV2(join(installed, "demo"));
  put(repo, "skills-lock.json", lockFor({ demo: { treeHashV2: demoHash } }));
  put(repo, "outside.sh", "echo changed\n");
  symlinkSync(join(repo, "outside.sh"), join(installed, "demo/run.sh"));

  assert.deepEqual(verifyInstalledSkills({ repo, installed }), ["demo"]);
});

test("filename/content boundary repartition cannot preserve a tree digest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "framed-skill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "first/SKILL.md", "X");
  const original = skillTreeHashV2(join(root, "first"));
  put(root, "second/SKILL.m", "dX");
  assert.notEqual(skillTreeHashV2(join(root, "second")), original);
});

test("nested node_modules and .git files are authenticated", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "complete-skill-tree-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const installed = join(repo, ".agents/skills");
  put(repo, "skills/core/SKILL.md", "# Core\n");
  put(repo, ".agents/skills/demo/SKILL.md", "Run node_modules/tool.js\n");
  put(repo, ".agents/skills/demo/node_modules/tool.js", "safe();\n");
  put(repo, ".agents/skills/demo/.git/hooks/run", "safe-hook\n");
  const treeHashV2 = skillTreeHashV2(join(installed, "demo"));
  put(repo, "skills-lock.json", lockFor({ demo: { treeHashV2 } }));

  put(repo, ".agents/skills/demo/node_modules/tool.js", "attacker();\n");
  assert.deepEqual(verifyInstalledSkills({ repo, installed }), ["demo"]);
});

test("case-colliding installed paths are refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "case-colliding-skill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "SKILL.md", "# Demo\n");
  put(root, "Script.js", "one\n");
  put(root, "script.js", "two\n");
  assert.throws(() => skillTreeHashV2(root), /Case-colliding/u);
});

test("case-colliding directory paths are refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "case-colliding-directory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "Scripts/first.js", "one\n");
  put(root, "scripts/second.js", "two\n");
  assert.throws(() => skillTreeHashV2(root), /Case-colliding/u);
});

test("legacy installer hashes cannot stand in for framed tree hashes", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "legacy-skill-lock-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const installed = join(repo, ".agents/skills");
  put(repo, "skills/core/SKILL.md", "# Core\n");
  put(repo, ".agents/skills/demo/SKILL.md", "# Demo\n");
  put(
    repo,
    "skills-lock.json",
    `${JSON.stringify({ skills: { demo: { computedHash: "a".repeat(64) } } })}\n`,
  );
  assert.throws(
    () => verifyInstalledSkills({ repo, installed }),
    /supported integrity catalogue/u,
  );
});
