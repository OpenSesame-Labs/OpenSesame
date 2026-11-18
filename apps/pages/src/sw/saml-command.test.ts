import { SamlPostCommandSchema } from "@opensesame/app-core/browser/saml/post-wire.js";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSamlPostCommand } from "./saml-command.generated.js";

const nonce = "A".repeat(43);
const point = "B".repeat(87);
const commands = [
  {
    kind: "SAML_ARM",
    nonce,
    requestId: "_request",
    expiresAt: 1,
    idpOrigin: "https://idp.example",
    publicKey: point,
  },
  { kind: "SAML_CANCEL", nonce },
  { kind: "SAML_METADATA" },
  { kind: "SAML_CLAIM", nonce, recordId: "record" },
  { kind: "SAML_CONSUME", nonce, recordId: "record" },
];
const keys = [
  "kind",
  "nonce",
  "requestId",
  "expiresAt",
  "idpOrigin",
  "publicKey",
  "recordId",
  "unexpected",
  "__proto__",
];

function sameResult(input: BoundaryValue): void {
  const expected = SamlPostCommandSchema.safeParse(input);
  const actual = parseSamlPostCommand(input);
  if (expected.success) expect(actual).toEqual(expected.data);
  else expect(actual).toBeNull();
}

describe("the generated SAML worker command parser", () => {
  it("matches Zod on command boundaries, extra keys and normalized URLs", () => {
    const values: BoundaryValue[] = [
      undefined,
      null,
      false,
      true,
      0,
      NaN,
      Infinity,
      1n,
      "",
      [],
      {},
      new Date(0),
      new Map(),
      ...commands,
    ];
    const changes: BoundaryValue[] = [
      undefined,
      null,
      "",
      0,
      1,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      1n,
      {},
      [],
      nonce,
      point,
      "https://a",
      "https://exa\nmple.com",
      " \thttps://a\n ",
      "_a",
      "x".repeat(128),
      "x".repeat(129),
      `https://a/${"x".repeat(2048)}`,
    ];
    for (const command of commands) {
      for (const key of keys) {
        for (const value of changes) values.push({ ...command, [key]: value });
        const missing = { ...command };
        Reflect.deleteProperty(missing, key);
        values.push(missing);
      }
    }
    for (const value of [
      "\0https://example.com",
      "https://example.com\0",
      "http:example.com",
      "mailto:hello@example.com",
      "about:blank",
      "data:text/plain,a",
      "file:///path",
      `https://a/${"x".repeat(2038)}\n`,
    ])
      values.push({ ...commands[0], idpOrigin: value });
    for (const prototype of [
      { kind: "SAML_METADATA" },
      { kind: "SAML_METADATA", unknown: true },
      { kind: "SAML_CANCEL", nonce },
      null,
    ])
      values.push(overlapCast(Object.create(prototype)));
    for (const key of [
      "__proto__",
      "toString",
      "constructor",
      "hasOwnProperty",
    ]) {
      const value = { kind: "SAML_METADATA" };
      Object.defineProperty(value, key, { enumerable: true, value: "extra" });
      values.push(value);
    }
    for (const value of values) sameResult(value);
  });

  it("matches the schema on generated malformed and mutated messages", () => {
    const candidate = fc.oneof(
      fc.jsonValue(),
      fc.constantFrom(...commands),
      fc
        .tuple(
          fc.constantFrom(...commands),
          fc.constantFrom(...keys),
          fc.jsonValue(),
        )
        .map(([command, key, value]) => ({ ...command, [key]: value })),
      fc.record({
        kind: fc.constantFrom(
          "SAML_ARM",
          "SAML_CANCEL",
          "SAML_METADATA",
          "SAML_CLAIM",
          "SAML_CONSUME",
          "OTHER",
        ),
        nonce: fc.oneof(fc.string(), fc.constant(nonce)),
        requestId: fc.oneof(fc.string(), fc.constant("_request")),
        expiresAt: fc.integer(),
        idpOrigin: fc.oneof(fc.string(), fc.constant("https://idp.example")),
        publicKey: fc.oneof(fc.string(), fc.constant(point)),
        recordId: fc.oneof(fc.string(), fc.constant("record")),
      }),
    );
    fc.assert(fc.property(candidate, sameResult), {
      seed: 248037,
      numRuns: 20000,
    });
  });
});
