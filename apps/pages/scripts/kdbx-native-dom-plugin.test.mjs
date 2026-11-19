import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it as test } from "vitest";
import { classify } from "../src/lib/capabilities/classification.js";
import { kdbxNativeDOM } from "./kdbx-native-dom-plugin.mjs";

const root =
  process.env.PAGES_KDBX_TEST_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(resolve(root, "packages/app-core/package.json"));
const sdk = realpathSync(require.resolve("kdbxweb"));

test("only replaces the reviewed SDK's exact XML fallback", () => {
  assert.equal(classify("src/lib/kdbx-native-dom.ts"), null);
  assert.equal(
    classify("src/browser/kdbx-native-dom.ts")?.classification,
    "core",
  );
  const plugin = kdbxNativeDOM(root);
  assert.equal(plugin.apply, undefined);
  plugin.buildStart();
  assert.equal(
    plugin.resolveId("@xmldom/xmldom", sdk),
    fileURLToPath(
      new URL(
        "../../../packages/app-core/src/browser/kdbx-native-dom.ts",
        import.meta.url,
      ),
    ),
  );
  for (const importer of [
    undefined,
    `${sdk}?other`,
    `${sdk}/other`,
    sdk.replace("kdbxweb", "other"),
    resolve(root, "packages/app-core/src/browser/saml/xml-policy.ts"),
  ]) {
    assert.equal(plugin.resolveId("@xmldom/xmldom", importer), null);
  }
  for (const source of [
    "@xmldom/xmldom/lib/dom.js",
    "xmldom",
    "crypto",
    "kdbxweb",
  ])
    assert.equal(plugin.resolveId(source, sdk), null);
});

test("only the KDBX importer receives the reviewed, tree-shakable SDK source", () => {
  const plugin = kdbxNativeDOM(root);
  const consumer = resolve(
    root,
    "packages/app-core/src/lib/vault/import/formats/kdbx.ts",
  );
  const source = resolve(dirname(dirname(sdk)), "lib");
  const entry = plugin.resolveId("kdbxweb", consumer);
  assert.equal(entry, "\0opensesame-kdbx-source");
  assert.equal(
    plugin.resolveId("kdbxweb", consumer.replaceAll("/", "\\")),
    entry,
  );
  assert.equal(plugin.resolveId("kdbxweb", `${consumer}?other`), null);
  assert.equal(plugin.resolveId("kdbxweb", undefined), null);
  assert.match(plugin.load(entry), /KdbxCredentials as Credentials/);
  assert.match(plugin.load(entry), /crypto-engine\.ts/);
  assert.equal(plugin.load("other"), null);
  assert.equal(
    plugin.transform(
      "global.crypto.subtle",
      resolve(source, "crypto/crypto-engine.ts"),
    ),
    "globalThis.crypto.subtle",
  );
  assert.equal(
    plugin.transform(
      "global.crypto.subtle",
      `${resolve(source, "crypto/crypto-engine.ts")}?v=deadbeef`,
    ),
    "globalThis.crypto.subtle",
  );
  assert.equal(
    plugin.transform(
      "global.crypto.subtle",
      resolve(source, "crypto/crypto-engine.ts").replaceAll("/", "\\"),
    ),
    "globalThis.crypto.subtle",
  );
  assert.match(
    plugin.transform(
      "require('@xmldom/xmldom')",
      resolve(source, "utils/xml-utils.ts"),
    ),
    /nativeKdbxDom/,
  );
  assert.equal(plugin.transform("global.crypto", "/unrelated.ts"), null);
});

test("both reviewed AES-KDF call sites use the worker adapter, without redirecting other imports", () => {
  const plugin = kdbxNativeDOM(root);
  const source = resolve(dirname(dirname(sdk)), "lib");
  const adapter = resolve(
    root,
    "packages/app-core/src/lib/vault/import/formats/kdbx-aes-kdf-worker-client.ts",
  );
  const v3 = resolve(source, "format/kdbx-format.ts");
  const v4 = resolve(source, "crypto/key-encryptor-kdf.ts");
  assert.equal(plugin.resolveId("../crypto/key-encryptor-aes", v3), adapter);
  assert.equal(plugin.resolveId("./key-encryptor-aes", v4), adapter);
  assert.equal(
    plugin.resolveId("./key-encryptor-aes", `${v4}?v=deadbeef`),
    adapter,
  );
  assert.equal(plugin.resolveId("./key-encryptor-aes", v3), null);
  assert.equal(plugin.resolveId("../crypto/key-encryptor-aes", v4), null);
  assert.equal(plugin.resolveId("./key-encryptor-aes", `${v4}?other`), null);
  assert.equal(plugin.resolveId("./key-encryptor-aes", "/unrelated.ts"), null);
});

test("the dev worker uses the pinned source, including Vite worker and version queries", () => {
  const plugin = kdbxNativeDOM(root);
  plugin.configResolved({ command: "serve" });
  plugin.buildStart();
  const worker = resolve(
    root,
    "packages/app-core/src/lib/vault/import/formats/kdbx-argon2.worker.ts",
  );
  assert.match(
    plugin.transform("ignored", `${worker}?worker_file&type=module`),
    /import \* as KeyEncryptorAes from .*key-encryptor-aes\.ts/,
  );
  assert.equal(plugin.transform("ignored", `${worker}?raw`), null);
});

test("ordinary Node SDK resolution and XML integrity remain unchanged", async () => {
  const xml = createRequire(sdk)("@xmldom/xmldom");
  assert.equal(
    new xml.DOMParser().parseFromString("<Root/>", "application/xml")
      .documentElement.tagName,
    "Root",
  );
  const codec = require("kdbxweb");
  assert.throws(() => codec.XmlUtils.parse("<Root><missing></Root>"));
  const doc = codec.XmlUtils.parse("<Root><V>retained</V></Root>");
  assert.equal(doc.getElementsByTagName("V")[0].textContent, "retained");
});

test("a replacement SDK cannot acquire the pinned fallback adapter", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "kdbx-unreviewed-"));
  try {
    const packageRoot = resolve(
      directory,
      "packages/app-core/node_modules/kdbxweb",
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(resolve(packageRoot, "package.json"), '{"main":"index.js"}');
    const changed = resolve(packageRoot, "index.js");
    writeFileSync(changed, "module.exports = {};");
    const plugin = kdbxNativeDOM(directory);
    assert.throws(() => plugin.buildStart(), /reviewed SDK bytes/);
    assert.throws(
      () => plugin.resolveId("@xmldom/xmldom", changed),
      /reviewed SDK bytes/,
    );
    const dev = kdbxNativeDOM(directory);
    dev.configResolved({ command: "serve" });
    assert.doesNotThrow(() => dev.buildStart());
    const importer = resolve(
      directory,
      "packages/app-core/src/lib/vault/import/formats/kdbx.ts",
    );
    assert.throws(
      () => dev.resolveId("kdbxweb", importer),
      /reviewed SDK bytes/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a source change is refused even when the SDK distribution is unchanged", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "kdbx-source-unreviewed-"));
  try {
    const packageRoot = resolve(
      directory,
      "packages/app-core/node_modules/kdbxweb",
    );
    mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      resolve(packageRoot, "package.json"),
      '{"main":"dist/kdbxweb.js"}',
    );
    cpSync(sdk, resolve(packageRoot, "dist/kdbxweb.js"));
    cpSync(resolve(dirname(dirname(sdk)), "lib"), resolve(packageRoot, "lib"), {
      recursive: true,
    });
    writeFileSync(
      resolve(packageRoot, "lib/crypto/crypto-engine.ts"),
      "changed",
    );
    assert.throws(
      () => kdbxNativeDOM(directory).buildStart(),
      /reviewed source bytes/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("development rejects a pinned source changed after the server starts", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "kdbx-dev-source-"));
  try {
    const packageRoot = resolve(
      directory,
      "packages/app-core/node_modules/kdbxweb",
    );
    const importer = resolve(
      directory,
      "packages/app-core/src/lib/vault/import/formats/kdbx.ts",
    );
    mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
    mkdirSync(dirname(importer), { recursive: true });
    writeFileSync(
      resolve(packageRoot, "package.json"),
      '{"main":"dist/kdbxweb.js"}',
    );
    cpSync(sdk, resolve(packageRoot, "dist/kdbxweb.js"));
    cpSync(resolve(dirname(dirname(sdk)), "lib"), resolve(packageRoot, "lib"), {
      recursive: true,
    });
    cpSync(
      resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx.ts"),
      importer,
    );
    const plugin = kdbxNativeDOM(directory);
    plugin.configResolved({ command: "serve" });
    plugin.buildStart();
    assert.equal(
      plugin.resolveId("kdbxweb", importer),
      "\0opensesame-kdbx-source",
    );
    const engine = resolve(packageRoot, "lib/crypto/crypto-engine.ts");
    writeFileSync(engine, "modified");
    assert.throws(
      () => plugin.transform("modified", `${engine}?v=deadbeef`),
      /reviewed source bytes/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreviewed importer cannot silently gain a partial SDK", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "kdbx-importer-unreviewed-"));
  try {
    const packageRoot = resolve(
      directory,
      "packages/app-core/node_modules/kdbxweb",
    );
    mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      resolve(packageRoot, "package.json"),
      '{"main":"dist/kdbxweb.js"}',
    );
    cpSync(sdk, resolve(packageRoot, "dist/kdbxweb.js"));
    cpSync(resolve(dirname(dirname(sdk)), "lib"), resolve(packageRoot, "lib"), {
      recursive: true,
    });
    const importer = resolve(
      directory,
      "packages/app-core/src/lib/vault/import/formats/kdbx.ts",
    );
    mkdirSync(dirname(importer), { recursive: true });
    writeFileSync(importer, "import('kdbxweb').then(sdk => sdk.KdbxMeta);");
    assert.throws(
      () => kdbxNativeDOM(directory).buildStart(),
      /reviewed importer/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
