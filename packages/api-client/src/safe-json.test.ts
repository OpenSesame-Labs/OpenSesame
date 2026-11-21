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
      list: [1, "two", null, true],
    };
    expect(stringifyLosslessJson(value)).toBe(
      '{"plain":"text","list":[1,"two",null,true]}',
    );
  });

  it("round-trips caller strings that start with the sentinel byte-exact", () => {
    const colliding = [
      "__opensesame_lossless_int__",
      "__opensesame_lossless_int__123",
      "__opensesame_lossless_int__-42",
      "__opensesame_lossless_int__9007199254740993123456789",
      "__opensesame_lossless_int__~already-escaped",
      "__opensesame_lossless_int__text",
    ];
    for (const value of colliding) {
      expect(parseLosslessJson(stringifyLosslessJson(value))).toBe(value);
    }
    const nested = { marker: colliding, deep: [{ k: colliding[2] }] };
    expect(parseLosslessJson(stringifyLosslessJson(nested))).toEqual(nested);
  });

  it("strict parse refuses a sentinel string it cannot classify", () => {
    expect(() =>
      parseLosslessJson('"__opensesame_lossless_int__not-an-integer"'),
    ).toThrow("lossless_json_sentinel_collision");
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
      arguments: { amount: BIG, count: 7 },
      idempotency_key: "idem-1",
    });
    expect(calls[0]?.body).toContain('"amount":9007199254740993123456789');
    const intent: BoundaryValue = overlapCast(
      (frozen as { intent: unknown }).intent,
    );
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
