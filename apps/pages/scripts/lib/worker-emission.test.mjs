import assert from "node:assert/strict";
import { it } from "vitest";
import {
  emitWorkerChunks,
  prunePlaceholderAssets,
  workerChunkFor,
} from "./worker-emission.mjs";

it("retains worker metadata for capability graph consumers", () => {
  const bundle = {};
  const emittedChunks = new Map();
  const chunk = {
    fileName: "assets/worker.js",
    code: "globalThis.worker = true",
  };
  const emitted = [];
  emitWorkerChunks(
    { emitFile: (file) => emitted.push(file) },
    bundle,
    [chunk],
    emittedChunks,
  );
  assert.equal(workerChunkFor(bundle, chunk.fileName), chunk);
  assert.equal(emitted[0].type, "asset");
  assert.equal(emitted[0].source, chunk.code);
});

it("drops only unresolved Rolldown placeholders and refuses missing real assets", () => {
  const placeholder = "assets/!~{abc123}~.js";
  const bundle = {
    "assets/host.js": {
      type: "chunk",
      viteMetadata: {
        importedAssets: new Set([placeholder, "assets/missing.js"]),
      },
    },
  };
  assert.throws(() => prunePlaceholderAssets(bundle), /asset is absent/);
  const imports = bundle["assets/host.js"].viteMetadata.importedAssets;
  imports.delete("assets/missing.js");
  prunePlaceholderAssets(bundle);
  assert.equal(imports.has(placeholder), false);
});
