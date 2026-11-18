import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "vite";
import { test } from "vitest";

test("the WebMCP registrar bundles its secret-name guard without the full registry", async () => {
  const root = resolve(process.cwd(), "../..");
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      rollupOptions: {
        input: resolve(root, "packages/webmcp/src/registrar.ts"),
        preserveEntrySignatures: "strict",
      },
    },
  });
  const modules = result.output.flatMap((item) =>
    item.type === "chunk" ? Object.keys(item.modules) : [],
  );
  assert.ok(
    modules.some((id) =>
      id.endsWith("/capability-registry/src/secret-names.ts"),
    ),
  );
  assert.ok(
    modules.every((id) => !id.endsWith("/capability-registry/src/index.ts")),
  );
});
