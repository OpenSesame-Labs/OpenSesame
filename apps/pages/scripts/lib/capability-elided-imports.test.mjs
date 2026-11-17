import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { recordElidedDynamicImports } from "./capability-elided-imports.mjs";
import {
  chunkImports,
  compareGraphToDisk,
  loadLexer,
} from "./verify-dist-checks.mjs";

test("records minifier-elided edges without trusting newly injected imports", async () => {
  const dist = mkdtempSync(join(tmpdir(), "capability-elided-test-"));
  try {
    mkdirSync(join(dist, "assets"));
    const file = "assets/main.js";
    const code = 'import("./live.js"); import("./injected.js");';
    writeFileSync(join(dist, file), code);
    const graph = {
      entries: [],
      workers: [],
      publicFiles: [],
      assets: [{ file: "assets/live.js" }, { file: "assets/injected.js" }],
      chunks: [
        {
          file,
          imports: [],
          dynamicImports: ["assets/live.js", "assets/elided.js"],
          importedCss: [],
          importedAssets: [],
        },
      ],
    };
    const repoRoot = resolve(process.cwd(), "../..");
    await recordElidedDynamicImports(graph, dist, repoRoot);
    assert.deepEqual(graph.chunks[0].dynamicImports, ["assets/live.js"]);
    assert.deepEqual(graph.droppedReferences, [
      { from: file, to: "assets/elided.js" },
    ]);
    const { init, parse } = await loadLexer(repoRoot);
    await init;
    const disk = {
      entries: [],
      chunks: new Map([[file, chunkImports(parse, code, file)]]),
      externals: new Map(),
    };
    const findings = [];
    compareGraphToDisk(
      graph,
      disk,
      new Set([file, "assets/live.js", "assets/injected.js"]),
      (code) => findings.push(code),
    );
    assert.deepEqual(findings, ["DYNAMIC_EDGE_MISMATCH"]);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("retains declared edges when an import expression cannot be resolved", async () => {
  const dist = mkdtempSync(join(tmpdir(), "capability-dynamic-test-"));
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets/main.js"), "import(runtimePath);");
    const graph = {
      chunks: [
        { file: "assets/main.js", dynamicImports: ["assets/target.js"] },
      ],
    };
    await recordElidedDynamicImports(
      graph,
      dist,
      resolve(process.cwd(), "../.."),
    );
    assert.deepEqual(graph.chunks[0].dynamicImports, ["assets/target.js"]);
    assert.equal(graph.droppedReferences, undefined);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
