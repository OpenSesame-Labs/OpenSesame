import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAuthTrustedProvider } from "../config.js";
import { jwksForProvider } from "./agent-auth-id-jag-trust.js";
import { type PinnedRequest, guardedFetchSeams } from "./guarded-fetch.js";

const original = { ...guardedFetchSeams };
const publicAddress = "93.184.216.34";
const provider: AgentAuthTrustedProvider = {
  issuer: "https://idp.example",
  enabled: true,
  audiences: ["https://identity.example"],
  algorithms: ["ES256"],
  maxAgeSeconds: 300,
  maxAuthAgeSeconds: 3600,
  jwksUri: "https://keys.example/jwks",
};

beforeEach(() => {
  guardedFetchSeams.lookup = async () => [
    { address: publicAddress, family: 4 },
  ];
});

afterEach(() => {
  Object.assign(guardedFetchSeams, original);
  vi.restoreAllMocks();
});

it("pins the public DNS answer and applies the JWKS byte budget", async () => {
  const wire = vi.fn(async (_request: PinnedRequest) =>
    Response.json({ keys: [{ kty: "EC" }] }),
  );
  guardedFetchSeams.transport = wire;
  const globalFetch = vi.spyOn(globalThis, "fetch");
  expect(await jwksForProvider(provider)).toEqual({ keys: [{ kty: "EC" }] });
  expect(globalFetch).not.toHaveBeenCalled();
  expect(wire).toHaveBeenCalledOnce();
  expect(wire.mock.calls[0]?.[0]).toMatchObject({
    address: publicAddress,
    maxBytes: 65_536,
    url: new URL("https://keys.example/jwks"),
  });
});

it("rejects private DNS answers, URL credentials and plaintext HTTP before a request", async () => {
  const wire = vi.fn();
  guardedFetchSeams.transport = wire;
  guardedFetchSeams.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
  await expect(jwksForProvider(provider)).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    jwksForProvider({ ...provider, jwksUri: "https://user@keys.example/jwks" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    jwksForProvider({ ...provider, jwksUri: "http://keys.example/jwks" }),
  ).rejects.toMatchObject({ status: 400 });
  expect(wire).not.toHaveBeenCalled();
});

it("cancels a chunked JWKS once its actual bytes exceed the limit", async () => {
  const canceled = vi.fn();
  let chunks = 0;
  guardedFetchSeams.transport = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(chunks === 1 ? 65_536 : 1));
        },
        cancel: canceled,
      }),
    );
  await expect(jwksForProvider(provider)).rejects.toMatchObject({
    status: 400,
  });
  expect(canceled).toHaveBeenCalledOnce();
});

it("enforces the limit in the real pinned transport while reading the response", async () => {
  const server = createServer((_request, response) => {
    response.end(Buffer.alloc(65_537, 0x78));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    // The guard still sees a public DNS answer. This test-only seam directs
    // the already checked request to a local HTTP fixture for the real reader.
    guardedFetchSeams.transport = (request) =>
      original.transport({
        ...request,
        address: "127.0.0.1",
        url: new URL(`http://keys.example:${port}/jwks`),
      });
    await expect(jwksForProvider(provider)).rejects.toMatchObject({
      status: 400,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("refuses redirects and an oversized declared response", async () => {
  guardedFetchSeams.transport = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://other.example" },
    });
  await expect(jwksForProvider(provider)).rejects.toMatchObject({
    status: 400,
  });
  const canceled = vi.fn();
  guardedFetchSeams.transport = async () =>
    new Response(new ReadableStream({ cancel: canceled }), {
      headers: { "content-length": "65537" },
    });
  await expect(jwksForProvider(provider)).rejects.toMatchObject({
    status: 400,
  });
  expect(canceled).toHaveBeenCalledOnce();
});

it.each(["null", '{"keys":[null]}', '{"keys":[]}', "not-json"])(
  "refuses malformed JWKS %s",
  async (body) => {
    guardedFetchSeams.transport = async () => new Response(body);
    await expect(jwksForProvider(provider)).rejects.toMatchObject({
      status: 400,
    });
  },
);

it("uses explicitly configured inline keys without a network request", async () => {
  const wire = vi.fn();
  guardedFetchSeams.transport = wire;
  const jwks = { keys: [{ kty: "EC" }] };
  expect(await jwksForProvider({ ...provider, jwks })).toEqual(jwks);
  expect(wire).not.toHaveBeenCalled();
});
