import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sdkHash =
  "322db6aaf84a1f8f1928323d41561196961b097445cea54cadd10a1f02bea135";
const sourceHash =
  "9903bd94870d1b4b51760f95b1ccc2ffe60d5a42bce50a9d7758c24d9dc89ae7";
const importerHash =
  "39a63278198a030bea935c32599c1b79250f5dbdd21296da82cc397adcd0d047";
const moduleId = (path) => path?.replaceAll("\\", "/");
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
  const virtual = "\0opensesame-kdbx-source";
  const verify = () => {
    const hash = createHash("sha256").update(readFileSync(sdk)).digest("hex");
    if (hash !== sdkHash)
      throw new Error(
        "KDBX native DOM adapter requires the reviewed SDK bytes.",
      );
    if (hashSourceTree(source) !== sourceHash)
      throw new Error(
        "KDBX source adapter requires the reviewed source bytes.",
      );
    const importerBytes = readFileSync(importer, "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    if (
      createHash("sha256").update(importerBytes).digest("hex") !== importerHash
    )
      throw new Error("KDBX source adapter requires the reviewed importer.");
  };
  return {
    name: "kdbx-native-dom",
    apply: "build",
    enforce: "pre",
    buildStart: verify,
    resolveId(id, owner) {
      if (id === "kdbxweb" && moduleId(owner) === importer) return virtual;
      if (id === virtual) return virtual;
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
      if (moduleId(id) === crypto)
        return code.replace(/\bglobal\./g, "globalThis.");
      if (moduleId(id) === xml) {
        const native = `import * as nativeKdbxDom from ${JSON.stringify(moduleId(adapter))};\n`;
        return (
          native +
          code
            .replace(/\bglobal\./g, "globalThis.")
            .replaceAll("require('@xmldom/xmldom')", "nativeKdbxDom")
        );
      }
      return null;
    },
  };
}
