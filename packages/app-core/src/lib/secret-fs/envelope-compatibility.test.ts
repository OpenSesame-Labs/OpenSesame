import { Effect, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigDoc, decodeConfig, encodeConfig } from "./config-docs.js";
import type { SecretFsRejected } from "./errors.js";
import {
  FolderDoc,
  ManifestDoc,
  SecretDoc,
  decodeFolderDoc,
  decodeManifestDoc,
  decodeSecretDoc,
} from "./secret-docs.js";

// The original exported schemas are the oracle for the on-disk format,
// including ignored fields, nested values and malformed input.
const legacySealed = ConfigDoc.fields.sealed;
const legacyConfig = ConfigDoc;
const legacySecret = SecretDoc;
const legacyFolder = FolderDoc;
const legacyManifest = ManifestDoc;

const encoder = new TextEncoder();
const decodeLegacy = <A, I>(schema: Schema.Codec<A, I>, value: string) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.match({ onFailure: () => null, onSuccess: (result) => result }),
    ),
  );
const decodeCurrent = <A>(effect: Effect.Effect<A, SecretFsRejected>) =>
  Effect.runSync(
    effect.pipe(
      Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
    ),
  );

const sealed = { ivB64: "aXY=", ctB64: "Y2lwaGVydGV4dA==" };
const examples = [
  { format: "opensesame.secret", version: 1, kind: "login", sealed },
  { format: "opensesame.folder", version: 1, sealed },
  { format: "opensesame.vault", version: 1, sealed },
  {
    format: "opensesame.config",
    version: 1,
    path: "config/a",
    language: "yaml",
    sealed,
  },
];

describe("secret file envelope compatibility", () => {
  it("snapshots input bytes before the returned Effect runs", () => {
    function check<A>(
      decode: (
        bytes: Uint8Array,
        path: string,
      ) => Effect.Effect<A, SecretFsRejected>,
      value: unknown,
    ) {
      const bytes = encoder.encode(JSON.stringify(value));
      const effect = decode(bytes, "x");
      bytes.fill(0);
      expect(decodeCurrent(effect)).toEqual(value);
    }
    check(decodeSecretDoc, examples[0]);
    check(decodeFolderDoc, examples[1]);
    check(decodeManifestDoc, examples[2]);
  });

  it("accepts and rejects the same legacy files and strips the same unknown keys", () => {
    const candidate = fc.oneof(
      fc.jsonValue(),
      fc.constantFrom(...examples),
      fc
        .tuple(fc.constantFrom(...examples), fc.jsonValue(), fc.jsonValue())
        .map(([doc, outer, inner]) => ({
          ...doc,
          unknown: outer,
          sealed: { ...doc.sealed, unknown: inner },
        })),
      fc
        .tuple(
          fc.constantFrom(...examples),
          fc.constantFrom(
            "format",
            "version",
            "kind",
            "path",
            "language",
            "sealed",
          ),
          fc.jsonValue(),
        )
        .map(([doc, key, value]) => ({ ...doc, [key]: value })),
    );
    fc.assert(
      fc.property(candidate, (value) => {
        const text = JSON.stringify(value);
        const bytes = encoder.encode(text);
        expect(decodeCurrent(decodeSecretDoc(bytes, "x"))).toEqual(
          decodeLegacy(legacySecret, text),
        );
        expect(decodeCurrent(decodeFolderDoc(bytes, "x"))).toEqual(
          decodeLegacy(legacyFolder, text),
        );
        expect(decodeCurrent(decodeManifestDoc(bytes, "x"))).toEqual(
          decodeLegacy(legacyManifest, text),
        );
        const config = decodeLegacy(legacyConfig, text);
        expect(decodeConfig(bytes)).toEqual(
          config === null
            ? null
            : {
                path: config.path,
                value: JSON.stringify(config.sealed),
              },
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("retains legacy config encoding and rejects malformed bytes without leaking details", () => {
    for (const text of [
      "",
      "{",
      "null",
      "[]",
      "{}",
      '{"ivB64":"x","ctB64":"y","extra":7}',
      JSON.stringify(sealed),
    ]) {
      const prior = decodeLegacy(legacySealed, text);
      const actual = encodeConfig("config/x.yaml", text);
      if (prior === null) expect(actual).toBeNull();
      else {
        expect(actual).not.toBeNull();
        if (actual === null) throw new Error("Expected an encoded config");
        expect(JSON.parse(new TextDecoder().decode(actual))).toEqual({
          format: "opensesame.config",
          version: 1,
          path: "config/x.yaml",
          language: "yaml",
          sealed: prior,
        });
      }
    }
    for (const bytes of [
      encoder.encode("{"),
      new Uint8Array([0xff, 0xff]),
      encoder.encode("null"),
    ]) {
      const failures = [
        Effect.runSync(
          decodeSecretDoc(bytes, "private/path").pipe(Effect.flip),
        ),
        Effect.runSync(
          decodeFolderDoc(bytes, "private/path").pipe(Effect.flip),
        ),
        Effect.runSync(
          decodeManifestDoc(bytes, "private/path").pipe(Effect.flip),
        ),
      ];
      for (const error of failures) {
        expect(error).toMatchObject({
          _tag: "SecretFsRejected",
          path: "private/path",
          kind: "corrupt",
          reason: "is not a file of this format",
        });
      }
      expect(decodeConfig(bytes)).toBeNull();
    }
  });
});
