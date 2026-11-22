import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it as test } from "vitest";
import { kdbxWorkerAssets } from "./kdbx-worker-assets.mjs";

const root =
  process.env.PAGES_KDBX_TEST_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(resolve(root, "packages/app-core/package.json"));
const sdkRoot = dirname(dirname(require.resolve("kdbxweb")));
const paths = [
  "crypto/key-encryptor-aes.ts",
  "crypto/crypto-engine.ts",
  "crypto/chacha20.ts",
  "utils/byte-utils.ts",
  "errors/kdbx-error.ts",
  "defs/consts.ts",
];

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "kdbx-worker-pins-"));
  const pkg = resolve(directory, "packages/app-core/node_modules/kdbxweb");
  const owner = resolve(
    directory,
    "packages/app-core/src/lib/vault/import/formats/kdbx-argon2-worker-client.ts",
  );
  const worker = resolve(dirname(owner), "kdbx-argon2.worker.ts");
  mkdirSync(dirname(worker), { recursive: true });
  mkdirSync(resolve(pkg, "dist"), { recursive: true });
  writeFileSync(
    resolve(pkg, "package.json"),
    JSON.stringify({ name: "kdbxweb", main: "dist/kdbxweb.js" }),
  );
  writeFileSync(resolve(pkg, "dist/kdbxweb.js"), "");
  writeFileSync(worker, 'import { KeyEncryptorAes } from "kdbxweb";\n');
  for (const path of paths) {
    const target = resolve(pkg, "lib", path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(sdkRoot, "lib", path), target);
  }
  return {
    directory,
    pkg,
    owner,
    worker,
    plan: {
      owner,
      specifier: "./kdbx-argon2.worker.ts",
      name: "kdbx-argon2.worker",
    },
  };
}

test("only pinned AES sources enter the KDBX worker, using browser crypto", () => {
  const f = fixture();
  try {
    const assets = kdbxWorkerAssets([f.plan]);
    const aes = resolve(f.pkg, "lib/crypto/key-encryptor-aes.ts");
    const engine = resolve(f.pkg, "lib/crypto/crypto-engine.ts");
    const originalEngine = readFileSync(engine, "utf8");
    assert(assets.owns(aes, "kdbx-argon2.worker"));
    assert(!assets.owns(aes, "other.worker"));
    assert(
      !assets.owns(resolve(f.pkg, "lib/format/kdbx.ts"), "kdbx-argon2.worker"),
    );
    assert.match(
      assets.load(null, f.worker),
      /import \* as KeyEncryptorAes from/,
    );
    const engineForWorker = assets.load(null, engine);
    assert.match(engineForWorker, /globalThis\.crypto/);
    assert.doesNotMatch(engineForWorker, /import \* as nodeCrypto/);
    assert.equal(readFileSync(engine, "utf8"), originalEngine);
    assert.equal(kdbxWorkerAssets([]), undefined);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("modified or redirected upstream AES sources fail closed", () => {
  const f = fixture();
  try {
    const aes = resolve(f.pkg, "lib/crypto/key-encryptor-aes.ts");
    writeFileSync(aes, `${readFileSync(aes, "utf8")}\n// modified\n`);
    assert.throws(() => kdbxWorkerAssets([f.plan]), /digest differs/);
    rmSync(aes);
    symlinkSync(resolve(sdkRoot, "lib/crypto/key-encryptor-aes.ts"), aes);
    assert.throws(() => kdbxWorkerAssets([f.plan]), /canonical and pinned/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
