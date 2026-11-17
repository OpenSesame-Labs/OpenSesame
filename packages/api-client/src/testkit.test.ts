import { getEventListeners } from "node:events";
import { createHostApiStub } from "@opensesame/api-client/testkit";
import { withTestResources } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";

describe("Host API stub", () => {
  it("contract: drives a real client with explicitly scripted sync responses", async () => {
    await withTestResources(async (scope) => {
      const host = scope.use(createHostApiStub());
      const requests: { authorization: string | null; body: unknown }[] = [];
      host.route("POST", "/api/v1/sync/push", async (request) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json({ accepted: 1 });
      });
      host.route("POST", "/api/v1/sync/pull-page", async (request) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json({
          format: "opensesame-sync-page",
          version: 2,
          blobs: [
            {
              id: "blob-a",
              epoch: 2,
              ciphertext_epoch: 1,
              ciphertext_b64: "AQID",
            },
          ],
          next_after: { epoch: 2, id: "blob-a" },
          has_more: false,
        });
      });
      const client = createApiClient({
        baseUrl: host.baseUrl,
        fetchImpl: host.fetchImpl,
        accessToken: "test-capability",
      });
      await expect(
        client.syncPush([{ id: "blob-a", epoch: 1, ciphertextB64: "AQID" }]),
      ).resolves.toEqual({ accepted: 1 });
      await expect(
        client.syncPull({ epoch: 0, deviceId: "device-a" }),
      ).resolves.toEqual({
        blobs: [
          {
            id: "blob-a",
            epoch: 2,
            ciphertext_epoch: 1,
            ciphertext_b64: "AQID",
          },
        ],
        next_after: { epoch: 2, id: "blob-a" },
        has_more: false,
        plaintext: null,
      });
      expect(requests).toEqual([
        {
          authorization: "Bearer test-capability",
          body: { blobs: [{ id: "blob-a", epoch: 1, ciphertext: [1, 2, 3] }] },
        },
        {
          authorization: "Bearer test-capability",
          body: {
            after: { epoch: 1, id: "" },
            device_id: "device-a",
            limit: 32,
          },
        },
      ]);
    });
  });

  it("adversarial: fails closed for unregistered routes, methods and foreign origins", async () => {
    const host = createHostApiStub("https://host.example.test/prefix/");
    host.route("GET", "/health/live", () => new Response("ok"));
    const client = createApiClient({
      baseUrl: host.baseUrl,
      fetchImpl: host.fetchImpl,
    });
    try {
      await expect(client.health()).resolves.toEqual({ ok: true, body: "ok" });
      await expect(client.whoami()).rejects.toThrow(
        "unhandled_host_stub_request",
      );
      await expect(
        host.fetchImpl(`${host.baseUrl}/health/live`, { method: "POST" }),
      ).rejects.toThrow("unhandled_host_stub_request");
      await expect(
        host.fetchImpl("https://elsewhere.example.test/health/live"),
      ).rejects.toThrow("host_stub_foreign_origin");
      await expect(
        host.fetchImpl("https://host.example.test/health/live"),
      ).rejects.toThrow("unhandled_host_stub_request");
    } finally {
      await host.close();
    }
  });

  it("contract: can script a denial and a successful response for separate clients", async () => {
    const host = createHostApiStub();
    host.route("GET", "/api/v1/connections", (request) =>
      request.headers.get("authorization") === "Bearer allowed-for-this-test"
        ? Response.json({ connections: [] })
        : Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const client = (accessToken: string) =>
      createApiClient({
        baseUrl: host.baseUrl,
        fetchImpl: host.fetchImpl,
        accessToken,
      });
    try {
      await expect(
        client("allowed-for-this-test").listConnections(),
      ).resolves.toEqual({
        connections: [],
      });
      await expect(
        client("denied-for-this-test").listConnections(),
      ).rejects.toThrow("connections_failed:403:forbidden");
    } finally {
      await host.close();
    }
  });

  it("contract: passes query parameters and request bodies to the handler", async () => {
    const host = createHostApiStub();
    host.route("get", "/api/v1/sync-targets", (request) => {
      expect(new URL(request.url).searchParams.get("project_id")).toBe("a/b");
      return Response.json({ sync_targets: [] });
    });
    const client = createApiClient({
      baseUrl: host.baseUrl,
      fetchImpl: host.fetchImpl,
    });
    try {
      await expect(
        client.listSyncTargets({ projectId: "a/b" }),
      ).resolves.toEqual({
        sync_targets: [],
      });
      expect(() =>
        host.route("GET", "/api/v1/sync-targets", () => new Response()),
      ).toThrow("duplicate_host_stub_route");
      expect(() =>
        host.route("GET", "/path?query=1", () => new Response()),
      ).toThrow("invalid_host_stub_route");
      expect(() =>
        host.route("GET", "/a/../path", () => new Response()),
      ).toThrow("invalid_host_stub_route");
    } finally {
      await host.close();
    }
  });

  it("chaos: reset isolates instances and invalidates a pending response", async () => {
    const first = createHostApiStub();
    const second = createHostApiStub();
    let release = () => {};
    let announce = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    first.route("GET", "/health/live", async () => {
      announce();
      await waiting;
      return new Response("old");
    });
    second.route("GET", "/health/live", () => new Response("separate"));
    const a = createApiClient({
      baseUrl: first.baseUrl,
      fetchImpl: first.fetchImpl,
    });
    const b = createApiClient({
      baseUrl: second.baseUrl,
      fetchImpl: second.fetchImpl,
    });
    try {
      const pending = a.health();
      await started;
      first.reset();
      release();
      await expect(pending).rejects.toThrow("host_stub_request_invalidated");
      await expect(a.health()).rejects.toThrow("unhandled_host_stub_request");
      await expect(b.health()).resolves.toEqual({ ok: true, body: "separate" });
      first.route("GET", "/health/live", () => new Response("new"));
      await expect(a.health()).resolves.toEqual({ ok: true, body: "new" });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    await first.close();
    await expect(a.health()).rejects.toThrow("host_stub_closed");
    expect(() => first.reset()).toThrow("host_stub_closed");
  });

  it("contract: reset does not cancel a response body already given to a caller", async () => {
    const host = createHostApiStub();
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.route(
      "GET",
      "/health/live",
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              await ready;
              controller.enqueue(new TextEncoder().encode("old body"));
              controller.close();
            },
          }),
        ),
    );
    try {
      const response = await host.fetchImpl(`${host.baseUrl}/health/live`);
      const body = response.text();
      host.reset();
      release?.();
      await expect(body).resolves.toBe("old body");
    } finally {
      await host.close();
    }
  });

  it("adversarial: does not run a handler for an already aborted request", async () => {
    const host = createHostApiStub();
    let called = false;
    host.route("GET", "/health/live", () => {
      called = true;
      return new Response("ok");
    });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        host.fetchImpl(`${host.baseUrl}/health/live`, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(called).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("chaos: abort rejects a stalled handler and handles its late rejection", async () => {
    const host = createHostApiStub();
    const controller = new AbortController();
    let failLate = (_error: Error) => {};
    let announce = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    host.route("GET", "/health/live", () => {
      const result = new Promise<Response>((_resolve, reject) => {
        failLate = reject;
      });
      announce();
      return result;
    });
    const pending = host.fetchImpl(`${host.baseUrl}/health/live`, {
      signal: controller.signal,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      const reason = new Error("request canceled");
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("abort timed out")), 1000);
      });
      controller.abort(reason);
      await expect(Promise.race([pending, timeout])).rejects.toBe(reason);
      // The stub must still observe this rejected promise after abort wins.
      failLate(new Error("late handler failure"));
      await Promise.resolve();
    } finally {
      clearTimeout(timer);
      failLate(new Error("fixture cleanup"));
      await pending.catch(() => {});
      await host.close();
    }
  });

  it.each(["reset", "close"] as const)(
    "chaos: %s immediately invalidates a stalled handler",
    async (action) => {
      const host = createHostApiStub();
      let failLate = (_error: Error) => {};
      let announce = () => {};
      let signal: AbortSignal | undefined;
      let listeners = 0;
      const started = new Promise<void>((resolve) => {
        announce = resolve;
      });
      host.route("GET", "/health/live", (request) => {
        signal = request.signal;
        listeners = getEventListeners(request.signal, "abort").length;
        const result = new Promise<Response>((_resolve, reject) => {
          failLate = reject;
        });
        announce();
        return result;
      });
      const pending = host.fetchImpl(`${host.baseUrl}/health/live`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await started;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("invalidation timed out")),
            1000,
          );
        });
        const checked = expect(
          Promise.race([pending, timeout]),
        ).rejects.toThrow("host_stub_request_invalidated");
        if (action === "reset") host.reset();
        else await host.close();
        await checked;
        expect(signal).toBeDefined();
        if (!signal) throw new Error("handler did not capture its signal");
        expect(listeners).toBeGreaterThan(0);
        expect(getEventListeners(signal, "abort")).toHaveLength(listeners - 1);
        failLate(new Error("late handler failure"));
        await Promise.resolve();
      } finally {
        clearTimeout(timer);
        failLate(new Error("fixture cleanup"));
        await pending.catch(() => {});
        await host.close();
      }
    },
  );

  it("contract: removes abort listeners when a handler succeeds or fails", async () => {
    const host = createHostApiStub();
    const seen: { signal: AbortSignal; listeners: number }[] = [];
    const failure = new Error("handler failed");
    const recordSignal = (request: Request) => {
      seen.push({
        signal: request.signal,
        listeners: getEventListeners(request.signal, "abort").length,
      });
    };
    host.route("GET", "/ok", (request) => {
      recordSignal(request);
      return new Response("ok");
    });
    host.route("GET", "/error", (request) => {
      recordSignal(request);
      throw failure;
    });
    try {
      await host.fetchImpl(`${host.baseUrl}/ok`);
      await expect(host.fetchImpl(`${host.baseUrl}/error`)).rejects.toBe(
        failure,
      );
      expect(seen).toHaveLength(2);
      for (const entry of seen) {
        expect(entry.listeners).toBeGreaterThan(0);
        expect(getEventListeners(entry.signal, "abort")).toHaveLength(
          entry.listeners - 1,
        );
      }
    } finally {
      await host.close();
    }
  });
});
