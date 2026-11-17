import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import merge from "deepmerge";
import { rollup } from "rollup";

const root = resolve(import.meta.dirname, "../..");

test("esbuild resolves to the declared version from both workspace consumers", () => {
  for (const workspace of ["packages/app-core", "packages/cli"]) {
    const fromWorkspace = createRequire(join(root, workspace, "package.json"));
    const manifest = fromWorkspace("esbuild/package.json");
    assert.equal(manifest.version, "0.28.2");
    assert.equal(
      manifest.version,
      fromWorkspace("./package.json").devDependencies.esbuild,
    );
  }
});

test("the actual Rollup resolver selects package exports with the supported deepmerge", async () => {
  const temp = await mkdtemp(join(tmpdir(), "opensesame-node-resolve-"));
  try {
    const dependency = join(temp, "node_modules", "resolver-fixture");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "resolver-fixture",
        type: "module",
        exports: {
          ".": { browser: "./browser.js", default: "./default.js" },
        },
      }),
    );
    await writeFile(
      join(dependency, "browser.js"),
      'export default "browser-export";\n',
    );
    await writeFile(
      join(dependency, "default.js"),
      'export default "default-export";\n',
    );
    const entry = join(temp, "index.js");
    await writeFile(
      entry,
      'import value from "resolver-fixture"; export { value };\n',
    );
    const bundle = await rollup({
      input: entry,
      plugins: [nodeResolve({ browser: true })],
    });
    try {
      const { output } = await bundle.generate({ format: "es" });
      assert.match(output[0].code, /browser-export/);
      assert.doesNotMatch(output[0].code, /default-export/);
    } finally {
      await bundle.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("deepmerge rejects prototype keys while retaining ordinary nested data", () => {
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"values":[2]}}',
  );
  const result = merge({ nested: { values: [1] } }, source);
  assert.deepEqual(result.nested.values, [1, 2]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result, "constructor"), false);
});
