import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { parse } from "yaml";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();
const workflow = readFileSync(
  join(root, ".github/workflows/cd-ghcr-publish.yml"),
  "utf8",
);

describe("GHCR Pages sparse checkout and Biome", () => {
  it("loads capability-graph.mjs with plain node without packages/", () => {
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import "./apps/pages/scripts/lib/capability-graph.mjs"',
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(loaded.status, 0, loaded.stderr);
  });

  it("checks out .gitignore with biome.json for the Pages build", () => {
    const job = parse(workflow).jobs["web-pwa-amd64"];
    const checkout = job.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const paths = String(checkout.with["sparse-checkout"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.ok(paths.includes("/.gitignore"));
    assert.ok(paths.includes("/biome.json"));
  });

  it("biome format needs a root .gitignore when biome.json is present", () => {
    const fixture = mkdtempSync(join(tmpdir(), "ghcr-biome-ignore-"));
    const biome = createRequire(join(root, "package.json")).resolve(
      "@biomejs/biome/bin/biome",
    );
    const format = () =>
      spawnSync(
        process.execPath,
        [biome, "format", "--stdin-file-path", join(fixture, "file.ts")],
        {
          cwd: fixture,
          encoding: "utf8",
          input: "export const n=1\n",
        },
      );
    try {
      copyFileSync(join(root, "biome.json"), join(fixture, "biome.json"));
      const missing = format();
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /couldn't find an ignore file/);
      copyFileSync(join(root, ".gitignore"), join(fixture, ".gitignore"));
      const present = format();
      assert.equal(present.status, 0, present.stderr);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
