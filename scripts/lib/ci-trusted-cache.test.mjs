import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

// quality:test loads this file with Vitest. The CD contract also runs under node --test.
const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();
const trusted =
  "TRUSTED_CACHE_SAVE: ${{ github.event_name == 'merge_group' || (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}";
const workflows = [
  "ci.yml",
  "cd-pwa.yml",
  "cd-npm-cli.yml",
  "cd-npm-publish-proof.yml",
];

function read(name) {
  return readFileSync(join(root, ".github/workflows", name), "utf8");
}

function steps(jobBody) {
  return jobBody.split(/\n {6}- (?=name:|uses:)/);
}

describe("trusted install caches", () => {
  it("saves only on main, merge_group, and workflow_dispatch of main", () => {
    for (const name of workflows) {
      const text = read(name);
      assert.ok(text.includes(trusted), name);
      assert.ok(
        text.includes("NPM_CONFIG_CACHE: ${{ github.workspace }}/.npm-cache"),
        name,
      );
      assert.doesNotMatch(text, /actions\/setup-node|setup-node/, name);
      assert.doesNotMatch(text, /path: node_modules/, name);
    }
  });

  it("restores the lockfile npm cache and saves it only when trusted", () => {
    for (const name of workflows) {
      const text = read(name);
      const chunks = text.split(/\n {6}- (?=name:|uses:)/);
      const installs = chunks
        .map((step, at) => ({ step, at }))
        .filter(({ step }) => /\n {8}run: npm ci\b/.test(`\n${step}`));
      assert.ok(installs.length > 0, name);
      for (const { at } of installs) {
        const restore = chunks[at - 1] ?? "";
        const save = chunks[at + 1] ?? "";
        assert.ok(
          restore.includes(
            "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
          ),
          name,
        );
        assert.ok(restore.includes("path: .npm-cache"), name);
        assert.ok(
          restore.includes(
            "key: npm-download-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
          ),
          name,
        );
        assert.ok(save.includes("if: env.TRUSTED_CACHE_SAVE == 'true'"), name);
        assert.ok(save.includes("continue-on-error: true"), name);
        assert.ok(
          save.includes(
            "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
          ),
          name,
        );
        assert.equal(save.includes("path: node_modules"), false, name);
      }
    }
  });

  it("tunes mise and saves the Rust cache only on trusted refs", () => {
    const ci = read("ci.yml");
    const rust = ci.split("\n  rust-build:\n")[1].split("\n  typescript:\n")[0];
    const rustSteps = steps(rust);
    const cache = rustSteps.find((step) =>
      step.includes("Swatinem/rust-cache@"),
    );
    assert.ok(
      cache?.includes("save-if: ${{ env.TRUSTED_CACHE_SAVE == 'true' }}"),
    );
    assert.equal(cache?.includes("lookup-only: true"), false);
    for (const name of workflows) {
      const text = read(name);
      const mise = text
        .split("\n")
        .filter((line) => line.includes("jdx/mise-action@"));
      assert.ok(mise.length > 0, name);
      assert.ok(text.includes("cache_key_prefix: mise-v1"), name);
      assert.ok(text.includes("cache_save: ${{ env.TRUSTED_CACHE_SAVE }}"), name);
      assert.equal(
        (text.match(/cache_save: \$\{\{ env\.TRUSTED_CACHE_SAVE \}\}/g) ?? [])
          .length,
        mise.length,
        name,
      );
    }
  });
});
