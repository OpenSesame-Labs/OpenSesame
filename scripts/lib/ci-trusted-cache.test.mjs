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
const mainSeed =
  "MAIN_CACHE_SEED: ${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' }}";
const npmPrimary =
  "key: npm-download-v2-${{ runner.os }}-lock-${{ hashFiles('package-lock.json') }}";
const npmSeedPrefix = "npm-download-v2-${{ runner.os }}-seed-main-";
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

// ci.yml job ids are hyphenated. CD job ids also use underscores
// (`preview_smoke`, `main_ci`). A file with one job stays one body.
function workflowJobs(name, text) {
  const section = text.split("\njobs:\n")[1];
  if (section === undefined) {
    return [{ id: name, body: text }];
  }
  const jobs = [
    ...section.matchAll(
      /^ {2}([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9_-]*:\n|(?![\s\S]))/gm,
    ),
  ].map((match) => ({ id: match[1], body: match[2] }));
  if (jobs.length < 2) {
    return [{ id: name, body: text }];
  }
  return jobs;
}

describe("trusted install caches", () => {
  it("saves only on main, merge_group, and workflow_dispatch of main", () => {
    for (const name of workflows) {
      const text = read(name);
      assert.ok(text.includes(trusted), name);
      assert.ok(text.includes(mainSeed), name);
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
      const jobs = workflowJobs(name, text);
      let installsSeen = 0;
      for (const { id, body } of jobs) {
        const chunks = steps(body);
        const installs = chunks
          .map((step, at) => ({ step, at }))
          .filter(({ step }) => /\n {8}run: npm ci\b/.test(`\n${step}`));
        installsSeen += installs.length;
        if (id === "workflow-inventory-gate") {
          // contents: read only, so this job restores and does not save.
          assert.equal(installs.length, 1, id);
          const restore = chunks[installs[0].at - 1] ?? "";
          assert.ok(
            restore.includes(
              "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
            ),
            id,
          );
          assert.ok(restore.includes("path: .npm-cache"), id);
          assert.ok(restore.includes(npmPrimary), id);
          assert.ok(restore.includes(npmSeedPrefix), id);
          assert.equal(body.includes("actions/cache/save@"), false, id);
          continue;
        }
        for (const { at } of installs) {
          const label = `${name}:${id}`;
          if (id === "preview_smoke") {
            // Restores npm, then chrome and mise, then npm ci. The build
            // job saves the npm cache. This job does not.
            const restore =
              [...chunks.slice(0, at)]
                .reverse()
                .find((step) => step.includes(npmPrimary)) ?? "";
            assert.ok(
              restore.includes(
                "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
              ),
              label,
            );
            assert.ok(restore.includes("path: .npm-cache"), label);
            assert.ok(restore.includes(npmPrimary), label);
            assert.ok(restore.includes(npmSeedPrefix), label);
            assert.equal(
              chunks
                .slice(at + 1)
                .some(
                  (step) =>
                    step.includes(npmPrimary) &&
                    step.includes("actions/cache/save@"),
                ),
              false,
              label,
            );
            continue;
          }
          const restore = chunks[at - 1] ?? "";
          const save = chunks[at + 1] ?? "";
          assert.ok(
            restore.includes(
              "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
            ),
            label,
          );
          assert.ok(restore.includes("path: .npm-cache"), label);
          assert.ok(restore.includes(npmPrimary), label);
          assert.ok(restore.includes(npmSeedPrefix), label);
          assert.ok(
            save.includes("if: env.TRUSTED_CACHE_SAVE == 'true'"),
            label,
          );
          assert.ok(save.includes("continue-on-error: true"), label);
          assert.ok(
            save.includes(
              "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
            ),
            label,
          );
          assert.ok(save.includes(npmPrimary), label);
          assert.equal(save.includes("seed-main"), false, label);
          assert.equal(save.includes("path: node_modules"), false, label);
          const seed = chunks[at + 2] ?? "";
          const log = chunks[at + 3] ?? "";
          assert.ok(seed.includes("if: env.MAIN_CACHE_SEED == 'true'"), label);
          assert.ok(
            seed.includes(
              `key: ${npmSeedPrefix}\${{ hashFiles('package-lock.json') }}`,
            ),
            label,
          );
          assert.ok(log.includes("node scripts/lib/ci-cache-seed.mjs"), label);
          assert.ok(log.includes("CACHE_NAME: npm"), label);
        }
      }
      assert.ok(installsSeen > 0, name);
    }
  });

  it("tunes mise and saves the Rust cache only on trusted refs", () => {
    const ci = read("ci.yml");
    const rust = ci.split("\n  rust-build:\n")[1].split("\n  typescript:\n")[0];
    const rustSteps = steps(rust);
    const cache = rustSteps.find((step) =>
      step.includes("Swatinem/rust-cache@"),
    );
    assert.ok(cache?.includes("prefix-key: v0-rust"));
    assert.ok(cache?.includes("shared-key: ${{ github.job }}"));
    assert.ok(
      cache?.includes(
        "save-if: ${{ env.TRUSTED_CACHE_SAVE == 'true' && matrix.shard == 0 }}",
      ),
    );
    assert.equal(cache?.includes("lookup-only: true"), false);
    assert.ok(rust.includes("CACHE_NAME: rust"));
    assert.ok(rust.includes("CACHE_PROBE_DIR"));
    for (const name of workflows) {
      const text = read(name);
      const mise = text
        .split("\n")
        .filter((line) => line.includes("jdx/mise-action@"));
      assert.ok(mise.length > 0, name);
      assert.ok(text.includes("cache: true"), name);
      assert.ok(text.includes("cache_save: false"), name);
      assert.ok(text.includes("mise-v1-nosave-${{ github.run_id }}"), name);
      assert.equal(
        text.includes("cache_save: ${{ env.TRUSTED_CACHE_SAVE }}"),
        false,
        name,
      );
      const saves = text
        .split("\n")
        .filter((line) => line.includes("actions/cache/save@"));
      assert.ok(saves.length > 0, name);
      assert.ok(text.includes("if: env.TRUSTED_CACHE_SAVE == 'true'"), name);
      assert.ok(text.includes("if: env.MAIN_CACHE_SEED == 'true'"), name);
      assert.ok(text.includes("mise-v2-${{ runner.os }}-seed-main-"), name);
      assert.ok(text.includes("node scripts/lib/ci-cache-seed.mjs"), name);
      assert.doesNotMatch(text, /path: node_modules/, name);
    }
  });
});
