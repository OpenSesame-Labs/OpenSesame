import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { jwksForProvider } from "./agent-auth-id-jag-trust.js";
import {
  type PinnedRequest,
  UnsafeUpstreamError,
  guardedFetch,
  guardedFetchSeams,
} from "./guarded-fetch.js";

const original = { ...guardedFetchSeams };
const address = "93.184.216.34";
const records = [{ address, family: 4 }];

afterEach(() => {
  Object.assign(guardedFetchSeams, original);
  vi.restoreAllMocks();
});

/** Fail promptly if a DNS operation remains pending after its deadline. */
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("deadline did not settle")),
          500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("does not start DNS or transport for an already-aborted request", async () => {
  const controller = new AbortController();
  const reason = new Error("caller canceled");
  controller.abort(reason);
  const lookup = vi.fn(async () => records);
  const transport = vi.fn(async () => new Response("ok"));
  guardedFetchSeams.lookup = lookup;
  guardedFetchSeams.transport = transport;

  await expect(
    guardedFetch("https://keys.example/jwks", true, {
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(lookup).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it("expires while DNS is pending and does not dial after its late answer", async () => {
  let finishLookup: (result: typeof records) => void = () => undefined;
  guardedFetchSeams.lookup = () =>
    new Promise((resolve) => {
      finishLookup = resolve;
    });
  const transport = vi.fn(async () => new Response("ok"));
  guardedFetchSeams.transport = transport;
  const signal = AbortSignal.timeout(30);
  const outcome = guardedFetch("https://keys.example/jwks", true, {
    signal,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    expect(await within(outcome)).toBe(signal.reason);
    expect(signal.aborted).toBe(true);
  } finally {
    finishLookup(records);
    await outcome;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(transport).not.toHaveBeenCalled();
});

it("does not dial when the resolver synchronously aborts the request", async () => {
  const controller = new AbortController();
  const reason = new Error("canceled during lookup");
  const transport = vi.fn(async () => new Response("ok"));
  guardedFetchSeams.lookup = async () => {
    controller.abort(reason);
    return records;
  };
  guardedFetchSeams.transport = transport;

  await expect(
    guardedFetch("https://keys.example/jwks", true, {
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(transport).not.toHaveBeenCalled();
});

it("applies the ID-JAG JWKS deadline while DNS is pending", async () => {
  let finishLookup: (result: typeof records) => void = () => undefined;
  guardedFetchSeams.lookup = () =>
    new Promise((resolve) => {
      finishLookup = resolve;
    });
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(controller.signal);
  const transport = vi.fn(async () => new Response("ok"));
  guardedFetchSeams.transport = transport;
  const result = jwksForProvider({
    issuer: "https://idp.example",
    enabled: true,
    audiences: ["https://identity.example"],
    algorithms: ["ES256"],
    maxAgeSeconds: 300,
    maxAuthAgeSeconds: 3600,
    jwksUri: "https://keys.example/jwks",
  });

  expect(timeout).toHaveBeenCalledWith(5_000);
  controller.abort();
  try {
    await expect(within(result)).rejects.toMatchObject({ status: 400 });
  } finally {
    finishLookup(records);
    await result.catch(() => undefined);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(transport).not.toHaveBeenCalled();
});

it("still refuses a DNS answer containing a private address", async () => {
  const transport = vi.fn(async () => new Response("ok"));
  guardedFetchSeams.lookup = async () => [
    ...records,
    { address: "127.0.0.1", family: 4 },
  ];
  guardedFetchSeams.transport = transport;

  await expect(
    guardedFetch("https://keys.example/jwks", true),
  ).rejects.toBeInstanceOf(UnsafeUpstreamError);
  expect(transport).not.toHaveBeenCalled();
});

it("still aborts the real pinned transport after DNS succeeds", async () => {
  let markReceived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    markReceived = resolve;
  });
  const server = createServer(() => markReceived());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  guardedFetchSeams.lookup = async () => records;
  // Keep the real pinned transport and direct it to an isolated HTTP fixture.
  guardedFetchSeams.transport = (request) =>
    original.transport({
      ...request,
      address: "127.0.0.1",
      url: new URL(`http://keys.example:${port}/jwks`),
    });
  const outcome = guardedFetch("https://keys.example/jwks", true, {
    signal: controller.signal,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    await within(received);
    controller.abort();
    expect(await within(outcome)).toMatchObject({ name: "AbortError" });
  } finally {
    controller.abort();
    await outcome;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("still pins and dials a public DNS answer before the deadline", async () => {
  const controller = new AbortController();
  const transport = vi.fn(
    async (_request: PinnedRequest) => new Response("ok"),
  );
  guardedFetchSeams.lookup = async () => records;
  guardedFetchSeams.transport = transport;

  const response = await guardedFetch("https://keys.example/jwks", true, {
    signal: controller.signal,
  });
  expect(await response.text()).toBe("ok");
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[0]).toMatchObject({
    address,
    signal: controller.signal,
    url: new URL("https://keys.example/jwks"),
  });
});
