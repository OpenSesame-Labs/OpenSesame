import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

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
      expect(text, name).toContain(trusted);
      expect(text, name).toContain(
        "NPM_CONFIG_CACHE: ${{ github.workspace }}/.npm-cache",
      );
      expect(text, name).not.toMatch(/actions\/setup-node|setup-node/);
      expect(text, name).not.toMatch(/path: node_modules/);
    }
  });

  it("restores the lockfile npm cache and saves it only when trusted", () => {
    for (const name of workflows) {
      const text = read(name);
      const chunks = text.split(/\n {6}- (?=name:|uses:)/);
      const installs = chunks
        .map((step, at) => ({ step, at }))
        .filter(({ step }) => /\n {8}run: npm ci\b/.test(`\n${step}`));
      expect(installs.length, name).toBeGreaterThan(0);
      for (const { at } of installs) {
        const restore = chunks[at - 1] ?? "";
        const save = chunks[at + 1] ?? "";
        expect(restore, name).toContain(
          "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
        );
        expect(restore, name).toContain("path: .npm-cache");
        expect(restore, name).toContain(
          "key: npm-download-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
        );
        expect(save, name).toContain("if: env.TRUSTED_CACHE_SAVE == 'true'");
        expect(save, name).toContain("continue-on-error: true");
        expect(save, name).toContain(
          "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
        );
        expect(save, name).not.toContain("path: node_modules");
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
    expect(cache).toContain("save-if: ${{ env.TRUSTED_CACHE_SAVE == 'true' }}");
    expect(cache).not.toContain("lookup-only: true");
    for (const name of workflows) {
      const text = read(name);
      const mise = text
        .split("\n")
        .filter((line) => line.includes("jdx/mise-action@"));
      expect(mise.length, name).toBeGreaterThan(0);
      expect(text, name).toContain("cache_key_prefix: mise-v1");
      expect(text, name).toContain("cache_save: ${{ env.TRUSTED_CACHE_SAVE }}");
      expect(
        (text.match(/cache_save: \$\{\{ env\.TRUSTED_CACHE_SAVE \}\}/g) ?? [])
          .length,
        name,
      ).toBe(mise.length);
    }
  });
});
