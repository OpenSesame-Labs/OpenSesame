import {
  composeStubFetch,
  createHostApiStub,
} from "@opensesame/api-client/testkit";
import { withTestResources } from "@opensesame/testing";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./index.js";

describe("composed service stubs", () => {
  it("contract: the real client reaches Host and daemon stubs without sharing its token", async () => {
    await withTestResources(async (scope) => {
      const host = scope.use(createHostApiStub());
      const daemon = scope.use(createHostApiStub("http://127.0.0.1:18790"));
      host.route("POST", "/api/v1/sync/push", async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-only");
        expect(await request.json()).toEqual({
          blobs: [{ id: "blob-a", epoch: 1, ciphertext: [1, 2, 3] }],
        });
        return Response.json({ accepted: 1 });
      });
      daemon.route("GET", "/health", (request) => {
        expect(request.headers.get("authorization")).toBeNull();
        return Response.json({ ok: true, daemon: "test" });
      });
      const client = createApiClient({
        baseUrl: host.baseUrl,
        accessToken: "test-only",
        fetchImpl: composeStubFetch(host, daemon),
      });

      await expect(
        client.syncPush([{ id: "blob-a", epoch: 1, ciphertextB64: "AQID" }]),
      ).resolves.toEqual({ accepted: 1 });
      await expect(client.probeDaemon(daemon.baseUrl)).resolves.toEqual({
        available: true,
        url: daemon.baseUrl,
        health: { ok: true, daemon: "test" },
      });
    });
  });

  it("adversarial: refuses unregistered and ambiguous origins without network fallback", async () => {
    await withTestResources(async (scope) => {
      const host = scope.use(createHostApiStub("https://example.test/prefix"));
      const duplicate = scope.use(
        createHostApiStub("https://example.test/other"),
      );
      const nativeFetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => {
          throw new Error("network fetch should never run");
        });
      try {
        expect(() => composeStubFetch(host, duplicate)).toThrow(
          "duplicate_stub_origin",
        );
        expect(() =>
          composeStubFetch({
            baseUrl: "http://outside.example",
            fetchImpl: host.fetchImpl,
          }),
        ).toThrow("invalid_stub_origin");
        const fetcher = composeStubFetch(host);
        await expect(
          fetcher("https://foreign.example.test/health"),
        ).rejects.toThrow("unhandled_stub_origin");
        await expect(fetcher("https://example.test/health")).rejects.toThrow(
          "unhandled_host_stub_request",
        );
        expect(nativeFetch).not.toHaveBeenCalled();
      } finally {
        nativeFetch.mockRestore();
      }
    });
  });

  it("contract: resets and closes each service independently", async () => {
    await withTestResources(async (scope) => {
      const host = scope.use(createHostApiStub());
      const daemon = scope.use(createHostApiStub("http://127.0.0.1:18790"));
      const fetcher = composeStubFetch(host, daemon);
      host.route("GET", "/health/live", () => new Response("host"));
      daemon.route("GET", "/health", () => new Response("daemon"));
      expect(await (await fetcher(`${host.baseUrl}/health/live`)).text()).toBe(
        "host",
      );
      host.reset();
      await expect(fetcher(`${host.baseUrl}/health/live`)).rejects.toThrow(
        "unhandled_host_stub_request",
      );
      expect(await (await fetcher(`${daemon.baseUrl}/health`)).text()).toBe(
        "daemon",
      );
      await host.close();
      await expect(fetcher(`${host.baseUrl}/health/live`)).rejects.toThrow(
        "host_stub_closed",
      );
      expect(await (await fetcher(`${daemon.baseUrl}/health`)).text()).toBe(
        "daemon",
      );
    });
  });

  it("contract: reset leaves a response body already handed to the caller intact", async () => {
    await withTestResources(async (scope) => {
      const host = scope.use(createHostApiStub());
      const fetcher = composeStubFetch(host);
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      host.route(
        "GET",
        "/stream",
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                await waiting;
                controller.enqueue(new TextEncoder().encode("body"));
                controller.close();
              },
            }),
          ),
      );
      const response = await fetcher(`${host.baseUrl}/stream`);
      const body = response.text();
      host.reset();
      release();
      await expect(body).resolves.toBe("body");
    });
  });

  it.each(["abort", "reset", "close"] as const)(
    "chaos: %s reaches a pending composed request and consumes a late failure",
    async (action) => {
      await withTestResources(async (scope) => {
        const host = scope.use(createHostApiStub());
        const fetcher = composeStubFetch(host);
        const controller = new AbortController();
        let announce = () => {};
        let failLate = (_error: Error) => {};
        const started = new Promise<void>((resolve) => {
          announce = resolve;
        });
        host.route("GET", "/stalled", () => {
          const result = new Promise<Response>((_resolve, reject) => {
            failLate = reject;
          });
          announce();
          return result;
        });
        const pending = fetcher(`${host.baseUrl}/stalled`, {
          signal: controller.signal,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await started;
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("cancellation timed out")),
              1000,
            );
          });
          const expected =
            action === "abort"
              ? "request canceled"
              : "host_stub_request_invalidated";
          const checked = expect(
            Promise.race([pending, timeout]),
          ).rejects.toThrow(expected);
          if (action === "abort") controller.abort(new Error(expected));
          else if (action === "reset") host.reset();
          else await host.close();
          await checked;
          failLate(new Error("late handler failure"));
          await Promise.resolve();
        } finally {
          clearTimeout(timer);
          failLate(new Error("fixture cleanup"));
          await pending.catch(() => {});
        }
      });
    },
  );
});
