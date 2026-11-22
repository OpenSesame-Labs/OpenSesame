import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { unpackGeneratedJson } from "../../../packages/app-core/src/lib/generated-json.ts";
import { isJsonObject, isString } from "../../../scripts/lib/json-boundary.mjs";
import {
  generatedDataAssets,
  generatedDataInputs,
  readPackedGeneratedData,
  renderGeneratedDataModule,
} from "./generated-data-assets.mjs";

const inputs = generatedDataInputs();
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rowInputs = inputs.filter((input) => input.kind === "rows");
const stringInputs = inputs.filter((input) => input.kind === "packed-string");
const arrayInputs = inputs.filter((input) => input.kind === "literal-array");
const moduleInputs = inputs.filter((input) => input.kind === "literal-module");
const catalogInputs = inputs.filter(
  (input) => input.kind === "capability-catalog",
);
const bundledInputs = inputs.filter((input) => input.kind === "bundled-export");
const jsonInputs = inputs.filter((input) => input.kind === "json-default");
const packInputs = inputs.filter((input) => input.kind === "pack-index");
const embeddedInputs = inputs.filter(
  (input) => input.kind === "embedded-array",
);

test.each([
  "gate-goals",
  "vault-item-goals",
  "shell-tour-goals",
  "vault-create-goals",
])(
  "%s remains executable instead of freezing live tutorial behavior",
  (file) => {
    const path = join(
      repoRoot,
      "packages/app-core/src/tutorial/registry",
      `${file}.ts`,
    );
    assert.equal(generatedDataAssets().transform("", path), null);
  },
);

test.each(catalogInputs)(
  "$exportName extracts the exact authored catalog behind source and value pins",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.equal(data.descriptors.length, 46);
    assert.equal(data.descriptors[0].id, "shell.navigation");
    assert.equal(data.descriptors.at(-1).id, "vault.browser-autofill");
    assert.deepEqual(
      data.descriptors,
      JSON.parse(JSON.stringify(data.descriptors)),
    );
  },
);

test.each(bundledInputs)(
  "$exportName extracts its exact JSON-safe transitive static value",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.equal(Object.keys(data.value).length, 144);
    assert.deepEqual(data.value, JSON.parse(JSON.stringify(data.value)));
  },
);

test.each(jsonInputs)(
  "$assetName moves its exact generated JSON default export to an asset",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.equal(isJsonObject(data.value) || Array.isArray(data.value), true);
    assert.deepEqual(data.value, JSON.parse(input.source));
  },
);

test.each(packInputs)(
  "$exportName extracts metadata while preserving dynamic pack loaders",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.equal(data.values.PACK_INDEX.length, 23);
    const rendered = renderGeneratedDataModule(input.source, input, "asset123");
    assert.match(rendered.code, /export const PACK_LOADERS = new Map/);
    assert.match(
      rendered.code,
      /import\("\.\/packs\/account\.generated\.js"\)/,
    );
  },
);

test.each(rowInputs)(
  "$exportName extracts the exact generated rows behind a source hash",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.ok(data.rows.length > 100);
    for (const [index, row] of data.rows.entries()) {
      assert.doesNotThrow(() =>
        JSON.parse(unpackGeneratedJson(row, data.dictionary)),
      );
      assert.equal(
        isString(JSON.parse(unpackGeneratedJson(row, data.dictionary)).id),
        true,
      );
      assert.equal(index in data.rows, true);
    }
  },
);

test.each(stringInputs)(
  "$exportName extracts exact JSON text behind its checked source",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.equal(isString(data.value), true);
    assert.doesNotThrow(() => JSON.parse(data.value));
  },
);

test.each(arrayInputs)(
  "$exportName extracts an exact JSON-safe literal array",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.ok(data.value.length > 0);
    assert.deepEqual(data.value, JSON.parse(JSON.stringify(data.value)));
  },
);

test.each(embeddedInputs)(
  "$exportName extracts its exact JSON-safe embedded array and preserves its module tail",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.ok(data.value.length > 0);
    assert.deepEqual(data.value, JSON.parse(JSON.stringify(data.value)));
    const rendered = renderGeneratedDataModule(input.source, input, "asset123");
    assert.ok(rendered.code.includes(input.declaration));
    assert.match(rendered.code, /__opensesameDataValue/);
    assert.ok(
      rendered.code.endsWith(
        input.source.slice(input.source.indexOf(input.expressionEnd)),
      ),
    );
  },
);

test.each(moduleInputs)(
  "$exportName extracts every exact JSON-safe tutorial export",
  (input) => {
    const data = readPackedGeneratedData(input.source, input);
    assert.deepEqual(Object.keys(data.values), input.exportNames);
    assert.deepEqual(data.values, JSON.parse(JSON.stringify(data.values)));
    for (const name of input.exportNames) {
      assert.notEqual(data.values[name], undefined);
    }
  },
);

test.each(inputs)("$exportName refuses any generated-source drift", (input) => {
  assert.throws(
    () => readPackedGeneratedData(`${input.source}\n`, input),
    /source pin mismatch/,
  );
});

test.each(inputs)(
  "$exportName keeps its public constants and synchronous export shape",
  (input) => {
    const rendered = renderGeneratedDataModule(input.source, input, "asset123");
    if (input.kind === "capability-catalog") {
      assert.match(
        rendered.code,
        /await fetch\(import\.meta\.ROLLUP_FILE_URL_asset123\)/,
      );
      assert.match(
        rendered.code,
        /export const CAPABILITY_CATALOG: CapabilityCatalog = buildCatalog/,
      );
      assert.doesNotMatch(rendered.code, /CORE_DESCRIPTORS/);
      return;
    }
    if (input.kind === "bundled-export") {
      assert.match(
        rendered.code,
        /await fetch\(import\.meta\.ROLLUP_FILE_URL_asset123\)/,
      );
      assert.match(
        rendered.code,
        new RegExp(`export const ${input.exportName} = value`),
      );
      return;
    }
    if (input.kind === "json-default") {
      assert.match(
        rendered.code,
        /await fetch\(import\.meta\.ROLLUP_FILE_URL_asset123\)/,
      );
      assert.match(rendered.code, /export default value/);
      return;
    }
    if (input.kind === "pack-index") {
      assert.match(rendered.code, /const \{ values \} = await response\.json/);
      assert.match(rendered.code, /export const PACK_LOADERS = new Map/);
      return;
    }
    if (input.kind === "literal-module") {
      assert.match(
        rendered.code,
        /await fetch\(import\.meta\.ROLLUP_FILE_URL_asset123\)/,
      );
      assert.match(rendered.code, /const \{ values \} = await response\.json/);
      for (const name of input.exportNames) {
        assert.match(rendered.code, new RegExp(`export const ${name} =`));
      }
      return;
    }
    if (input.kind === "embedded-array") {
      assert.match(
        rendered.code,
        /await fetch\(import\.meta\.ROLLUP_FILE_URL_asset123\)/,
      );
      assert.ok(rendered.code.includes(input.declaration));
      assert.doesNotMatch(rendered.code, /id: "listing\.next"/);
      return;
    }
    const prefixEnd =
      input.kind === "literal-array"
        ? input.source.indexOf(`export const ${input.exportName}`)
        : input.source.indexOf(
            'import { unpackGeneratedJson } from "./generated-json.js";',
          );
    const prefix = input.source.slice(0, prefixEnd);
    assert.ok(rendered.code.startsWith(prefix.trimEnd()));
    assert.match(
      rendered.code,
      /await fetch\(import\.meta\.ROLLUP_FILE_URL_asset123\)/,
    );
    assert.match(rendered.code, new RegExp(`export const ${input.exportName}`));
    if (input.kind === "rows") {
      assert.doesNotMatch(
        rendered.code,
        /const rows: readonly string\[\] = \[/,
      );
    } else {
      assert.match(
        rendered.code,
        /const \{ value \} = await response\.json\(\)/,
      );
    }
  },
);

test("the build plugin emits every included asset once", () => {
  const emitted = [];
  const plugin = generatedDataAssets();
  plugin.buildStart();
  for (const input of inputs) {
    if (input.kind === "json-default") continue;
    const result = plugin.transform.call(
      {
        emitFile(asset) {
          emitted.push(asset);
          return `ref${emitted.length}`;
        },
      },
      input.source,
      input.path,
    );
    assert.match(result.code, new RegExp(input.exportName));
  }
  for (const input of jsonInputs) {
    const resolved = plugin.resolveId(input.specifier ?? input.path);
    const loaded = plugin.load.call(
      {
        emitFile(asset) {
          emitted.push(asset);
          return `ref${emitted.length}`;
        },
      },
      resolved,
    );
    assert.match(loaded.code, /export default value/);
  }
  assert.equal(emitted.length, inputs.length);
  assert.ok(emitted.every((asset) => asset.type === "asset"));
});

test("the build plugin ignores tests and unrelated modules", () => {
  const plugin = generatedDataAssets();
  plugin.buildStart();
  assert.equal(plugin.apply, "build");
  assert.equal(plugin.enforce, "pre");
  assert.equal(plugin.transform("export const x = 1", "/fixture/x.ts"), null);
  assert.equal(
    plugin.transform(inputs[0].source, `${inputs[0].path}?fixture`),
    null,
  );
});

test("the build plugin resolves canonical relative JSON imports before Vite's JSON parser", () => {
  const plugin = generatedDataAssets();
  plugin.buildStart();
  assert.match(
    plugin.resolveId(
      "../../../spec/log-scrub/log-scrub.json",
      join(repoRoot, "packages/log-scrub/src/scrub.ts"),
    ),
    /generated-json/,
  );
  assert.match(
    plugin.resolveId(
      "../../../../../spec/conformance/2password-policy.json",
      join(repoRoot, "packages/app-core/src/lib/password-agent/policy.ts"),
    ),
    /generated-json/,
  );
});
