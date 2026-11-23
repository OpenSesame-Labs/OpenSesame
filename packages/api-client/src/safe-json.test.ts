import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";
import { parseLosslessJson, stringifyLosslessJson } from "./safe-json.js";

const BIG = 9007199254740993123456789n;

describe("lossless JSON integers", () => {
  it("keeps unsafe integers exact across parse and stringify", () => {
    const text =
      '{"safe":42,"big":9007199254740993123456789,"neg":-9007199254740993123456789,"float":1.5,"exp":1e3,"nested":[{"id":9007199254740993}],"label":"9007199254740993123456789"}';
    const parsed = parseLosslessJson(text);
    expect(parsed).toEqual({
      safe: 42,
      big: BIG,
      neg: -BIG,
      float: 1.5,
      exp: 1000,
      nested: [{ id: 9007199254740993n }],
      label: "9007199254740993123456789",
    });
    expect(stringifyLosslessJson(parsed)).toBe(
      text.replace('"exp":1e3', '"exp":1000'),
    );
  });

  it("matches JSON semantics for ordinary values", () => {
    const value = {
      plain: "text",
      skip: undefined,
      list: [1, "two", null, true, undefined, Number.NaN, -0, 1e21],
      when: new Date(0),
    };
    expect(stringifyLosslessJson(value)).toBe(JSON.stringify(value));
  });

  it("writes sparse array holes as null, as JSON.stringify does", () => {
    const mixed = [1];
    mixed[2] = 3; // leaves index 1 a hole
    const value = { items: new Array(2), one: new Array(1), mixed };
    expect(stringifyLosslessJson(value)).toBe(JSON.stringify(value));
    expect(stringifyLosslessJson(value)).toBe(
      '{"items":[null,null],"one":[null],"mixed":[1,null,3]}',
    );
  });

  it("writes and reads marker-shaped strings exactly as plain JSON does", () => {
    const strings = [
      "__opensesame_lossless_int__",
      "__opensesame_lossless_int__123",
      "__opensesame_lossless_int__-42",
      "__opensesame_lossless_int__9007199254740993123456789",
      "__opensesame_lossless_int__~already-escaped",
      "__opensesame_lossless_int__not-an-integer",
      "~__opensesame_lossless_int__1",
    ];
    const payload = { marker: strings, deep: [{ k: strings[1] }] };
    // The wire bytes are what the Host's ordinary JSON decoder reads.
    expect(stringifyLosslessJson(payload)).toBe(JSON.stringify(payload));
    for (const value of strings) {
      expect(stringifyLosslessJson(value)).toBe(JSON.stringify(value));
      expect(parseLosslessJson(JSON.stringify(value))).toBe(value);
    }
    // A plain Host response carrying such strings parses to the same strings.
    const hostResponse = JSON.stringify({ arguments: payload, count: 7 });
    expect(parseLosslessJson(hostResponse)).toEqual(JSON.parse(hostResponse));
  });

  it("writes integers beyond 2^53 as bare digits the Host reads as numbers", () => {
    const text = stringifyLosslessJson({ n: 9007199254740993n, m: -BIG });
    expect(text).toBe('{"n":9007199254740993,"m":-9007199254740993123456789}');
    expect(JSON.parse(text)).toEqual({
      n: Number(9007199254740993n),
      m: -Number(BIG),
    });
  });

  it("matches JSON.parse for every value it does not widen", () => {
    const text = String.raw` { "__proto__" : 1, "s":"a\"bé", "e":[ ], "o":{ }, "x":-0, "f":-1.25e-3, "k":9007199254740991, "dup":1, "dup":2, "u":"😀" } `;
    const parsed = parseLosslessJson(text);
    expect(parsed).toEqual(JSON.parse(text));
    expect(Object.keys(overlapCast(parsed))).toEqual(
      Object.keys(JSON.parse(text)),
    );
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("refuses malformed JSON exactly as JSON.parse does", () => {
    for (const bad of ["", "{", '{"a":}', "[1,]", "01", "tru", '"x" y']) {
      expect(() => parseLosslessJson(bad)).toThrow(SyntaxError);
    }
  });

  it("preserves frozen-intent integers through freeze and recovery", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const calls: { url: string; body: string }[] = [];
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body ?? "") });
        if (String(input).endsWith("/api/v1/tasks/intents")) {
          return new Response(
            `{"intent_id":"i-1","intent_digest":"${digest}","receipt_id":"receipt:018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb","intent":{"nonce":"n","canonical_arguments":{"amount":9007199254740993123456789,"count":7}}}`,
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ opening: `hmac-sha256:v1:${"a".repeat(64)}` }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const frozen = await client.createTaskIntent({
      task_run_id: "t-1",
      expected_state_version: 1,
      operation: "read",
      resource: "r1",
      audience: "https://api.example.test",
      arguments: {
        amount: BIG,
        count: 7,
        label: "__opensesame_lossless_int__7",
      },
      idempotency_key: "idem-1",
    });
    expect(calls[0]?.body).toContain('"amount":9007199254740993123456789');
    expect(calls[0]?.body).toContain('"label":"__opensesame_lossless_int__7"');
    const intent: BoundaryValue = overlapCast(frozen).intent;
    expect(intent).toEqual({
      nonce: "n",
      canonical_arguments: { amount: BIG, count: 7 },
    });
    await client.recoverTaskIntentOpening(intent, digest);
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/tasks/intent-opening",
    );
    expect(calls[1]?.body).toBe(
      `{"intent":{"nonce":"n","canonical_arguments":{"amount":9007199254740993123456789,"count":7}},"intent_digest":"${digest}"}`,
    );
  });
});
