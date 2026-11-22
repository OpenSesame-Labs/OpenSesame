import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVOCATION_RESPONSE_TIMEOUT_MS,
  MAX_INVOCATION_RESPONSE_BYTES,
  readFreezeIntentResponse,
  readInvocationResponse,
} from "./invocation-response.js";

afterEach(() => vi.useRealTimers());

describe("bounded invocation response", () => {
  it("cancels an oversized declared body without reading it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      headers: { "content-length": String(MAX_INVOCATION_RESPONSE_BYTES + 1) },
    });
    await expect(readInvocationResponse(response)).rejects.toThrow("limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels an oversized chunked body despite a small declared length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INVOCATION_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const response = new Response(body, { headers: { "content-length": "1" } });
    await expect(readInvocationResponse(response)).rejects.toThrow("limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("preserves unsafe integers in freeze canonical arguments", async () => {
    const unsafe = 9_007_199_254_740_993n;
    const body =
      '{"intent_id":"i-1","intent_digest":"sha256:abc","canonical_arguments":{"n":9007199254740993}}';
    const response = new Response(body, {
      headers: { "content-type": "application/json" },
    });
    const parsed = await readFreezeIntentResponse(response);
    // SAFETY: the fixture above fixes the freeze response shape; the test
    // projects only the canonical arguments it constructed.
    const args = overlapCast<
      BoundaryValue,
      { canonical_arguments: { n: bigint } }
    >(parsed).canonical_arguments;
    expect(args.n).toBe(unsafe);
  });

  it("accepts a freeze response larger than the receipt invoke cap", async () => {
    const payload = "x".repeat(MAX_INVOCATION_RESPONSE_BYTES + 1024);
    const body = JSON.stringify({
      intent_id: "i-1",
      intent_digest: "sha256:abc",
      canonical_arguments: { blob: payload },
    });
    const response = new Response(body, {
      headers: { "content-type": "application/json" },
    });
    await expect(readFreezeIntentResponse(response)).resolves.toEqual(
      JSON.parse(body),
    );
  });

  it("times out and cancels a stalled body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel,
    });
    const pending = expect(
      readInvocationResponse(new Response(body)),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(INVOCATION_RESPONSE_TIMEOUT_MS);
    await pending;
    expect(cancel).toHaveBeenCalled();
  });
});
