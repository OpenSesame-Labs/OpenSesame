import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const resolvers = [
  ["0.2", createRequire(join(root, "package.json"))],
  ["0.3", createRequire(join(root, "packages/app-core/package.json"))],
];

for (const [version, require] of resolvers) {
  const entry = require.resolve("@levischuck/tiny-cbor");
  const packageRoot = dirname(dirname(entry));
  const implementations = [
    ["CommonJS", require(entry)],
    ["ESM", await import(pathToFileURL(join(packageRoot, "esm/index.js")))],
  ];
  for (const [format, cbor] of implementations) {
    test(`${version} ${format}: respects offset views and valid UTF-8 lengths`, () => {
      for (const value of [
        "héllo 日本",
        "🙂 café",
        "λ".repeat(24),
        new Uint8Array([0, 1, 255]),
        256,
      ]) {
        const encoded = cbor.encodeCBOR(value);
        const outer = Uint8Array.from([0xaa, 0xbb, ...encoded, 0xcc, 0xdd]);
        const views = [
          new DataView(outer.buffer, 2, encoded.byteLength),
          outer.subarray(2, 2 + encoded.byteLength),
        ];
        views.push(Buffer.from(outer).subarray(2, 2 + encoded.byteLength));
        class ByteView extends Uint8Array {}
        views.push(new ByteView(outer).subarray(2, 2 + encoded.byteLength));
        for (const view of views)
          assert.deepEqual(cbor.decodeCBOR(view), value);
        assert.deepEqual(
          cbor.decodePartialCBOR(
            new DataView(outer.buffer, 1, outer.byteLength - 2),
            1,
          ),
          [value, encoded.byteLength],
        );
      }
      const map = new Map([
        ["name", "日本"],
        [1, new Uint8Array([3, 4])],
      ]);
      assert.deepEqual(cbor.decodeCBOR(cbor.encodeCBOR(map)), map);
    });

    test(`${version} ${format}: rejects strings and length headers truncated at a view boundary`, () => {
      for (const header of [0x42, 0x62]) {
        const backing = Uint8Array.of(0xff, header, 0x61, 0x62, 0xee);
        for (const view of [
          new DataView(backing.buffer, 1, 2),
          backing.subarray(1, 3),
          Uint8Array.of(header, 0x61),
        ]) {
          assert.throws(() => cbor.decodePartialCBOR(view, 0));
        }
      }
      const backing = Uint8Array.of(0xff, 0x19, 0x01, 0x00, 0xee);
      for (const view of [
        new DataView(backing.buffer, 1, 2),
        backing.subarray(1, 3),
      ]) {
        assert.throws(() => cbor.decodePartialCBOR(view, 0));
      }
    });
  }
}

test("SimpleWebAuthn accepts valid COSE maps and rejects truncated byte strings", async () => {
  const entry = join(
    root,
    "node_modules/@simplewebauthn/server/esm/helpers/iso/isoCBOR.js",
  );
  const webauthn = await import(pathToFileURL(entry));
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(32).fill(7)],
    [-3, new Uint8Array(32).fill(8)],
  ]);
  assert.deepEqual(webauthn.decodeFirst(webauthn.encode(cose)), cose);
  assert.throws(() => webauthn.decodeFirst(Uint8Array.of(0x42, 0xaa)));
});
