/** Pin the upstream AES-KDF implementation inside the KDBX worker realm. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const realm = "kdbx-argon2.worker";

export function combineWorkerAssets(...assets) {
  return {
    owns: (file, target) => assets.some((asset) => asset?.owns(file, target)),
    resolve: (file, target) =>
      assets.reduce(
        (value, asset) => asset?.resolve(value, target) ?? value,
        file,
      ),
    load(context, file) {
      for (const asset of assets) {
        const value = asset?.load(context, file);
        if (value !== undefined) return value;
      }
    },
  };
}

const pins = new Map([
  [
    "crypto/key-encryptor-aes.ts",
    "1adc80adf71d91f0f5033a0b360d82e9f3db304aedfcb230750dd6855cd566ac",
  ],
  [
    "crypto/crypto-engine.ts",
    "e39f02a61b61acff3e3c70d4d1a556f8937ac658bd7b20d8abbbf2c85c1b1465",
  ],
  [
    "crypto/chacha20.ts",
    "a2880cb1759577fe914753dc4ccbab5ff0159b6bf41f806a79ea5fb5719920f3",
  ],
  [
    "utils/byte-utils.ts",
    "d816387a05c3e06f7914c95dbec943a8e252a01a84dea313034633deef25cae1",
  ],
  [
    "errors/kdbx-error.ts",
    "a18749d30a20e499adde43b50bc6277a107fe996b7b747fd741974242fb4682f",
  ],
  [
    "defs/consts.ts",
    "71f53dff8108b0b759c8f48117391f3ebaeaaa4906ccb57b3cd805e5f8fa6947",
  ],
]);

function replaceOnce(code, source, replacement) {
  if (code.split(source).length !== 2)
    throw new Error("KDBX worker source did not match the reviewed adapter.");
  return code.replace(source, replacement);
}

/** Worker modules are independent of the host SDK's mutable state. */
export function kdbxWorkerAssets(workers) {
  const plan = workers.find((item) => item.name === realm);
  if (!plan) return undefined;
  const require = createRequire(plan.owner);
  const sdk = realpathSync(require.resolve("kdbxweb"));
  const root = resolve(dirname(dirname(sdk)), "lib");
  const files = new Map(
    [...pins].map(([name, pin]) => [resolve(root, name), pin]),
  );
  const worker = resolve(dirname(plan.owner), plan.specifier);
  const aes = resolve(root, "crypto/key-encryptor-aes.ts");
  const engine = resolve(root, "crypto/crypto-engine.ts");
  function pinned(file) {
    if (!files.has(file) || realpathSync(file) !== file)
      throw new Error("KDBX worker source must be canonical and pinned.");
    const code = readFileSync(file, "utf8");
    if (createHash("sha256").update(code).digest("hex") !== files.get(file))
      throw new Error("KDBX worker source digest differs.");
    return code;
  }
  for (const file of files.keys()) pinned(file);
  return {
    owns(file, target) {
      return target === realm && files.has(file);
    },
    resolve(file) {
      return file;
    },
    load(_context, file) {
      if (file === worker) {
        return replaceOnce(
          readFileSync(worker, "utf8"),
          'import { KeyEncryptorAes } from "kdbxweb";',
          `import * as KeyEncryptorAes from ${JSON.stringify(aes)};`,
        );
      }
      if (!files.has(file)) return undefined;
      const code = pinned(file);
      if (file !== engine) return code;
      // Browser workers require WebCrypto; the Node fallback is unavailable.
      return replaceOnce(
        code,
        "import * as nodeCrypto from 'crypto';",
        "const nodeCrypto = Object.freeze({});",
      ).replace(/\bglobal\./g, "globalThis.");
    },
  };
}
