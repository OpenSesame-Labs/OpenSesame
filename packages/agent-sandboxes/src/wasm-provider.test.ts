import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { virtualFetchOverHttp } from "./vnet.js";
import { WasmRelayProvider } from "./wasm-provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("WASM relay lifecycle", () => {
  it.each(["cloudflare", "vercel"] as const)(
    "deletes a per-run %s deployment without waiting for the relay",
    async (anonymousRelay) => {
      const fetch = vi.fn(async () => {
        throw new Error("relay is unavailable");
      });
      vi.stubGlobal("fetch", fetch);
      const close = vi.fn(async () => {});
      const provider = new WasmRelayProvider({
        anonymousRelay,
        deployRelay: async () => ({
          relayUrl: "https://relay.example.test",
          relayToken: "token",
          close,
        }),
      });
      const sandbox = await provider.allocate({
        origin: "https://example.test",
      });
      await sandbox.close();
      expect(fetch).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("still closes an externally managed session and reports failures", async () => {
    const closeSession = vi.fn(async () => {
      throw new Error("session close failed");
    });
    const provider = new WasmRelayProvider({
      virtualFetch: Object.assign(
        async () => ({ status: 200, url: "", headers: {}, bodyText: "" }),
        { closeSession },
      ),
    });
    const sandbox = await provider.allocate({
      origin: "https://example.test",
      session: "external-session",
    });
    await expect(sandbox.close()).rejects.toThrow("session close failed");
    expect(closeSession).toHaveBeenCalledWith("external-session");
  });

  it("deletes a deployment if its relay URL is invalid", async () => {
    const close = vi.fn(async () => {});
    const provider = new WasmRelayProvider({
      anonymousRelay: "vercel",
      deployRelay: async () => ({
        relayUrl: "http://relay.example.test",
        relayToken: "token",
        close,
      }),
    });
    await expect(
      provider.allocate({ origin: "https://example.test" }),
    ).rejects.toThrow("requires HTTPS");
    expect(close).toHaveBeenCalledOnce();
  });

  it("discards the client-carried cookie jar without a network request", async () => {
    const jarSchema = z.record(z.string(), z.record(z.string(), z.string()));
    const bodySchema = z.object({ jar: jarSchema });
    const jars: z.infer<typeof jarSchema>[] = [];
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        jars.push(bodySchema.parse(JSON.parse(String(init?.body))).jar);
        return Response.json({
          status: 200,
          url: "https://example.test",
          headers: {},
          bodyText: "",
          jar: { "https://example.test": { session: "secret" } },
        });
      },
    );
    const fetch = virtualFetchOverHttp("https://relay.example.test", "token");
    const request = {
      sessionId: "session",
      url: "https://example.test",
      method: "GET",
    };
    await fetch(request);
    await fetch(request);
    fetch.discardSession("session");
    await fetch(request);
    expect(jars).toEqual([
      {},
      { "https://example.test": { session: "secret" } },
      {},
    ]);
  });
});
