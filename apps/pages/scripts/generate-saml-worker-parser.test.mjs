import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SAML_POST_BYTES,
  SamlPostCommandSchema,
} from "@opensesame/app-core/browser/saml/post-wire.js";
import { it } from "vitest";
import { z } from "zod/mini";
import { formatSamlWorkerParser } from "./generate-saml-worker-parser.mjs";
import {
  checkSamlWorkerFresh,
  samlWorkerInputs,
} from "./saml-worker-freshness.mjs";

const output = fileURLToPath(
  new URL("../src/sw/saml-command.generated.ts", import.meta.url),
);
const root = fileURLToPath(new URL("../../..", import.meta.url));
function formatted(schema = SamlPostCommandSchema) {
  return formatSamlWorkerParser(schema, SAML_POST_BYTES, samlWorkerInputs());
}

it("keeps the generated worker parser current with the actual Zod contract", () => {
  const source = formatted();
  assert.equal(readFileSync(output, "utf8").replaceAll("\r\n", "\n"), source);
  checkSamlWorkerFresh(source, samlWorkerInputs());
  checkSamlWorkerFresh(source.replaceAll("\n", "\r\n"), samlWorkerInputs());
  assert.throws(
    () =>
      checkSamlWorkerFresh(source, {
        ...samlWorkerInputs(),
        sourceHash: "0".repeat(64),
      }),
    /stale/,
  );
  assert.throws(
    () =>
      checkSamlWorkerFresh(source, {
        ...samlWorkerInputs(),
        zodVersion: "0.0.0",
      }),
    /stale/,
  );
});

it("the build freshness guard rejects a changed generator as well as changed output", () => {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const fixture = mkdtempSync(join(work, "saml-parser-freshness-"));
  try {
    const copy = (path) => {
      const destination = join(fixture, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, path), destination);
    };
    for (const path of [
      "biome.json",
      ".gitignore",
      "apps/pages/scripts/generate-saml-worker-parser.mjs",
      "apps/pages/scripts/saml-worker-freshness.mjs",
      "apps/pages/scripts/write-saml-worker-parser.ts",
      "apps/pages/src/sw/saml-command.generated.ts",
      "packages/app-core/package.json",
      "packages/app-core/src/browser/saml/post-wire.ts",
      "packages/control-plane/package.json",
      "packages/os-domain/src/json.ts",
      "scripts/lib/json-boundary.mjs",
    ])
      copy(path);
    const freshness = pathToFileURL(
      join(fixture, "apps/pages/scripts/saml-worker-freshness.mjs"),
    ).href;
    const check = () =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertSamlWorkerFresh } from ${JSON.stringify(freshness)}; assertSamlWorkerFresh();`,
        ],
        { cwd: fixture, encoding: "utf8", stdio: "pipe" },
      );
    check();
    const generator = join(
      fixture,
      "apps/pages/scripts/generate-saml-worker-parser.mjs",
    );
    const original = readFileSync(generator, "utf8");
    const changed = original.replace(
      "SAML_POST_BYTES = ${bytes}",
      "SAML_POST_BYTES = ${bytes + 1}",
    );
    assert.notEqual(changed, original);
    writeFileSync(generator, changed);
    assert.throws(check, /SAML worker parser is stale/);
    writeFileSync(generator, original);
    const generated = join(
      fixture,
      "apps/pages/src/sw/saml-command.generated.ts",
    );
    writeFileSync(
      generated,
      `${readFileSync(generated, "utf8")}\n// tampered\n`,
    );
    assert.throws(check, /SAML worker parser is stale/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30000);

it("fails generation for unhandled validation and transformation behavior", () => {
  const fallback = z.strictObject({ kind: z.literal("fallback") });
  const alteredLength = z.minLength(1);
  alteredLength._zod.def.when = function _whenHasLength() {
    return false;
  };
  for (const unsupported of [
    z.object({ kind: z.literal("loose") }),
    z.strictObject({
      kind: z.literal("optional"),
      value: z.optional(z.string()),
    }),
    z.strictObject({
      kind: z.literal("transform"),
      value: z.string().check(z.trim()),
    }),
    z.strictObject({
      kind: z.literal("protocol"),
      value: z.url({ protocol: /^https$/ }),
    }),
    z.strictObject({
      kind: z.literal("custom"),
      value: z.string().check(z.refine(() => true)),
    }),
    z.strictObject({
      kind: z.literal("altered-condition"),
      value: z.string().check(alteredLength),
    }),
  ]) {
    assert.throws(
      () => formatted(z.union([unsupported, fallback])),
      /Unsupported SAML worker schema/,
    );
  }
});
