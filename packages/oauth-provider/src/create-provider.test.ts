import { once } from "node:events";
import { createServer } from "node:http";
import { isString, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  createLoadExistingGrant,
  createOpenSesameProvider,
} from "./create-provider.js";

describe("dynamic registration boundaries", () => {
  it("keeps finite metadata limits and requires an initial access token", async () => {
    const bundle = createOpenSesameProvider({
      env: { dcrEnabled: true, isProduction: false },
    });
    expect(bundle.configuration.fetchResponseBodyLimits).toEqual({
      "client_id metadata document": 5 * 1024,
      jwks_uri: 64 * 1024,
      sector_identifier_uri: 64 * 1024,
    });
    const server = createServer(bundle.provider.callback());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || isString(address)) throw new Error("Missing address");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/reg`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"],
        }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_token" });
      const token = await new bundle.provider.InitialAccessToken({}).save();
      const authorized = await fetch(`http://127.0.0.1:${address.port}/reg`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"],
        }),
      });
      expect(authorized.status).toBe(201);
      expect(await authorized.json()).toMatchObject({
        redirect_uris: ["https://client.example/callback"],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

/**
 * Durable consent reuse (`loadExistingGrant`): the session grant still wins,
 * `prompt=consent` always prompts, a widened scope request falls through to
 * the consent page, and only a full subset match materialises a grant.
 */

type FakeGrant = {
  accountId: string;
  clientId: string;
  scopes: string[];
  claims: string[];
  saved: boolean;
};

type FakeCtxOptions = {
  scope?: string;
  accountId?: string;
  clientId?: string;
  sessionGrantId?: string;
  prompts?: string[];
};

function fakeCtx(options: FakeCtxOptions) {
  const created: FakeGrant[] = [];
  class Grant {
    accountId: string;
    clientId: string;
    scopes: string[] = [];
    claims: string[] = [];
    saved = false;
    constructor(args: { accountId: string; clientId: string }) {
      this.accountId = args.accountId;
      this.clientId = args.clientId;
      const record: FakeGrant = overlapCast(this);
      created.push(record);
    }
    addOIDCScope(scope: string) {
      this.scopes.push(scope);
    }
    addOIDCClaims(claims: string[]) {
      this.claims.push(...claims);
    }
    async save() {
      this.saved = true;
      return "grant-id";
    }
    static found = { fromSession: true };
    static async find(_id: string) {
      return Grant.found;
    }
  }
  const prompts = new Set(options.prompts ?? []);
  const ctx = {
    oidc: {
      session: {
        accountId: options.accountId ?? "prn_1",
        grantIdFor: () => options.sessionGrantId,
      },
      client: { clientId: options.clientId ?? "app-1" },
      params: { scope: options.scope ?? "openid profile" },
      prompts: { has: (name: string) => prompts.has(name) },
      provider: { Grant },
    },
  };
  return { ctx, created, Grant };
}

describe("createLoadExistingGrant", () => {
  it("prefers the session's own grant, untouched", async () => {
    const lookup = vi.fn();
    const { ctx, Grant } = fakeCtx({ sessionGrantId: "g-1" });

    const grant = await createLoadExistingGrant(lookup)(ctx);

    expect(grant).toBe(Grant.found);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("materialises a grant from a stored consent that covers the request", async () => {
    const lookup = vi.fn(async () => ({
      scopes: ["openid", "profile"],
      claims: ["email_verified"],
    }));
    const { ctx, created } = fakeCtx({ scope: "openid profile" });

    const grant = await createLoadExistingGrant(lookup)(ctx);

    expect(lookup).toHaveBeenCalledWith("prn_1", "app-1");
    expect(grant).toBeTruthy();
    expect(created[0]).toMatchObject({
      accountId: "prn_1",
      clientId: "app-1",
      scopes: ["openid profile"],
      claims: ["email_verified"],
      saved: true,
    });
  });

  it("falls through when the request asks for a scope outside the stored set", async () => {
    const lookup = vi.fn(async () => ({ scopes: ["openid"], claims: [] }));
    const { ctx, created } = fakeCtx({ scope: "openid offline_access" });

    expect(await createLoadExistingGrant(lookup)(ctx)).toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it("always prompts on an explicit prompt=consent", async () => {
    const lookup = vi.fn(async () => ({
      scopes: ["openid", "profile"],
      claims: [],
    }));
    const { ctx } = fakeCtx({ prompts: ["consent"] });

    expect(await createLoadExistingGrant(lookup)(ctx)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls through when no consent is stored", async () => {
    const lookup = vi.fn(async () => null);
    const { ctx, created } = fakeCtx({});

    expect(await createLoadExistingGrant(lookup)(ctx)).toBeUndefined();
    expect(created).toHaveLength(0);
  });
});

const metadataUrl = "https://client.example/sector.json";
const redirect = "https://client.example/callback";

async function registerWithMetadata(response: Response) {
  const nativeFetch = globalThis.fetch;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, options) => {
      if (String(input) === metadataUrl) return response;
      return nativeFetch(input, options);
    });
  const { provider } = createOpenSesameProvider({
    env: { dcrEnabled: true, isProduction: false },
  });
  const token = await new provider.InitialAccessToken({}).save();
  const server = createServer(provider.callback());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || isString(address)) throw new Error("Missing address");
  try {
    const registered = await nativeFetch(
      `http://127.0.0.1:${address.port}/reg`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          redirect_uris: [redirect],
          sector_identifier_uri: metadataUrl,
        }),
      },
    );
    expect(fetch).toHaveBeenCalledWith(metadataUrl, expect.anything());
    return { status: registered.status, body: await registered.json() };
  } finally {
    fetch.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("DCR metadata response limits", () => {
  it("rejects an oversized declared response before consuming its body", async () => {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await registerWithMetadata(
      new Response(stream, { headers: { "content-length": "104857600" } }),
    );
    expect(result.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(reads).toBe(0);
  });

  it("cancels an unbounded chunked response once the byte limit is crossed", async () => {
    let bytes = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bytes += 4096;
          controller.enqueue(new Uint8Array(4096));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await registerWithMetadata(new Response(stream));
    expect(result.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(bytes).toBeLessThanOrEqual(64 * 1024 + 4096);
  });

  it("preserves authorized registration with a valid sector document", async () => {
    const result = await registerWithMetadata(Response.json([redirect]));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ sector_identifier_uri: metadataUrl });
  });
});
