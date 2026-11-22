import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { test } from "vitest";
import { cycles } from "../../../../scripts/lib/app-core-layering.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const modules = join(root, "apps/pages/src/modules");
const firstParty = (path) =>
  !path.includes("/node_modules/") &&
  (path.startsWith("apps/") || path.startsWith("packages/"));

test("capability runtime closures have no first-party static import cycles", async () => {
  const entryPoints = readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(modules, entry.name, "runtime.ts"))
    .filter(existsSync);
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    metafile: true,
    write: false,
    outdir: "out",
    logLevel: "silent",
    external: ["crypto", "node:*", "virtual:*"],
  });
  const edges = Object.entries(metafile.inputs).flatMap(([from, input]) =>
    input.imports
      .filter(
        ({ external, kind, path: to }) =>
          !external &&
          kind === "import-statement" &&
          firstParty(from) &&
          firstParty(to),
      )
      .map(({ path: to }) => ({ from, to, kind: "static" })),
  );
  assert.deepEqual(cycles(edges, ["static"]), []);
}, 20_000);
