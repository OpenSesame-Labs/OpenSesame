import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVOCATION_RESPONSE_TIMEOUT_MS,
  MAX_INVOCATION_RESPONSE_BYTES,
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
