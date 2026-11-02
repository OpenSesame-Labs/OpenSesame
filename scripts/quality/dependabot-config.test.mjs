import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(join(root, ".github/dependabot.yml"), "utf8");

function entries() {
  return config
    .split(/\n(?= {2}- package-ecosystem: )/)
    .slice(1)
    .map((text) => ({
      ecosystem: text.match(/package-ecosystem: (\S+)/)[1],
      directory: text.match(/directory: (\S+)/)[1],
      text,
    }));
}

test("dependabot npm workspaces use a single root directory entry", () => {
  const npm = entries().filter((entry) => entry.ecosystem === "npm");
  assert.equal(npm.length, 1);
  assert.equal(npm[0].directory, "/");
  assert.match(config, /npm workspaces use ONE root entry at \/ /);
  assert.match(config, /root package-lock\.json/);
  assert.match(config, /Do not add per-package directories/);
});

test("dependabot groups declare wildcard patterns", () => {
  const grouped = entries().filter((entry) =>
    ["npm", "cargo", "github-actions"].includes(entry.ecosystem),
  );
  assert.deepEqual(
    grouped.map((entry) => `${entry.ecosystem} ${entry.directory}`),
    ["cargo /", "cargo /tests/fuzz/cargo", "npm /", "github-actions /"],
  );
  for (const entry of grouped) {
    assert.match(entry.text, /patterns:\n\s+- "\*"/, entry.ecosystem);
  }
});
