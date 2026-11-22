import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { kdbxWorkerAssets } from "./kdbx-worker-assets.mjs";

const sdkHash =
  "322db6aaf84a1f8f1928323d41561196961b097445cea54cadd10a1f02bea135";
const sourceHash =
  "9903bd94870d1b4b51760f95b1ccc2ffe60d5a42bce50a9d7758c24d9dc89ae7";
// This importer retains the AES and Argon2 work budgets used by the worker.
const importerHash =
  "fd3823cf69305d024134ec1e3fb93c24a10e5b345572727b459984996888e9f6";
const moduleId = (path) => path?.replaceAll("\\", "/");
const sourceId = (path) =>
  moduleId(path)?.replace(/\?(?:(?:v=[0-9a-f]+|t=[0-9]+)&?)+$/, "");
const adapter = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/browser/kdbx-native-dom.ts",
    import.meta.url,
  ),
);

function hashSourceTree(root) {
  const files = [];
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("KDBX source tree must contain only regular files.");
    }
  }
  collect(root);
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verifySources({ sdk, source, importer }) {
  const hash = createHash("sha256").update(readFileSync(sdk)).digest("hex");
  if (hash !== sdkHash)
    throw new Error("KDBX native DOM adapter requires the reviewed SDK bytes.");
  if (hashSourceTree(source) !== sourceHash)
    throw new Error("KDBX source adapter requires the reviewed source bytes.");
  const importerBytes = readFileSync(importer, "utf8").replaceAll("\r\n", "\n");
  if (createHash("sha256").update(importerBytes).digest("hex") !== importerHash)
    throw new Error("KDBX source adapter requires the reviewed importer.");
}

function transformSource(code, id, state) {
  const {
    worker,
    workerAssets,
    serving,
    prepare,
    source,
    verify,
    crypto,
    xml,
  } = state;
  const current = moduleId(id);
  if (
    current === worker ||
    (current?.startsWith(`${worker}?`) &&
      /^worker_file(?:&type=module)?(?:&v=[0-9a-f]+)?$/.test(
        current.slice(worker.length + 1),
      ))
  ) {
    const assets = serving ? prepare() : workerAssets;
    if (!assets) throw new Error("KDBX worker source was not verified.");
    return assets.load(null, worker);
  }
  if (serving && sourceId(id)?.startsWith(`${moduleId(source)}/`)) verify();
  if (sourceId(id) === crypto)
    return code.replace(/\bglobal\./g, "globalThis.");
  if (sourceId(id) === xml) {
    const native = `import * as nativeKdbxDom from ${JSON.stringify(moduleId(adapter))};\n`;
    return (
      native +
      code
        .replace(/\bglobal\./g, "globalThis.")
        .replaceAll("require('@xmldom/xmldom')", "nativeKdbxDom")
    );
  }
  return null;
}

/** Use the pinned SDK's browser-compatible source only for the KDBX importer. */
export function kdbxNativeDOM(root) {
  const require = createRequire(
    resolve(root, "packages/app-core/package.json"),
  );
  const sdk = realpathSync(require.resolve("kdbxweb"));
  const source = resolve(dirname(dirname(sdk)), "lib");
  const crypto = moduleId(resolve(source, "crypto/crypto-engine.ts"));
  const xml = moduleId(resolve(source, "utils/xml-utils.ts"));
  const importer = moduleId(
    resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx.ts"),
  );
  const aesAdapter = moduleId(
    resolve(
      root,
      "packages/app-core/src/lib/vault/import/formats/kdbx-aes-kdf-worker-client.ts",
    ),
  );
  const aesImports = new Map([
    [
      moduleId(resolve(source, "format/kdbx-format.ts")),
      "../crypto/key-encryptor-aes",
    ],
    [
      moduleId(resolve(source, "crypto/key-encryptor-kdf.ts")),
      "./key-encryptor-aes",
    ],
  ]);
  const workerOwner = resolve(
    root,
    "packages/app-core/src/lib/vault/import/formats/kdbx-argon2-worker-client.ts",
  );
  const worker = moduleId(
    resolve(dirname(workerOwner), "kdbx-argon2.worker.ts"),
  );
  let workerAssets;
  let serving = false;
  const virtual = "\0opensesame-kdbx-source";
  const verify = () => verifySources({ sdk, source, importer });
  const prepare = () => {
    verify();
    workerAssets = kdbxWorkerAssets([
      {
        owner: workerOwner,
        specifier: "./kdbx-argon2.worker.ts",
        name: "kdbx-argon2.worker",
      },
    ]);
    return workerAssets;
  };
  return {
    name: "kdbx-native-dom",
    enforce: "pre",
    configResolved(config) {
      serving = config.command === "serve";
    },
    buildStart() {
      if (!serving) prepare();
    },
    resolveId(id, owner) {
      if (id === "kdbxweb" && sourceId(owner) === importer) {
        if (serving) prepare();
        return virtual;
      }
      if (id === virtual) return virtual;
      if (aesImports.get(sourceId(owner)) === id) {
        if (serving) prepare();
        return aesAdapter;
      }
      if (id === "@xmldom/xmldom" && moduleId(owner) === moduleId(sdk)) {
        verify();
        return adapter;
      }
      return null;
    },
    load(id) {
      if (id !== virtual) return null;
      const file = (name) => JSON.stringify(moduleId(resolve(source, name)));
      return [
        `export { Kdbx } from ${file("format/kdbx.ts")};`,
        `export { KdbxCredentials as Credentials } from ${file("format/kdbx-credentials.ts")};`,
        `export { ProtectedValue } from ${file("crypto/protected-value.ts")};`,
        `export * as CryptoEngine from ${file("crypto/crypto-engine.ts")};`,
        `export { KdbxError } from ${file("errors/kdbx-error.ts")};`,
        `export * as Consts from ${file("defs/consts.ts")};`,
      ].join("\n");
    },
    transform(code, id) {
      return transformSource(code, id, {
        worker,
        workerAssets,
        serving,
        prepare,
        source,
        verify,
        crypto,
        xml,
      });
    },
  };
}
