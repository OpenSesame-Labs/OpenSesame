import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { createControlPlaneClient } from "@opensesame/sdk-cli";
import { withTestResources } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { assertIdentityTestEnvironment } from "./environment.js";
import { startIdentityTestServer } from "./index.js";

async function publicSigningKey(baseUrl: string) {
  const response = await fetch(`${baseUrl}/jwks`);
  expect(response.status).toBe(200);
  const jwks: BoundaryValue = await response.json();
  if (
    !isJsonObject(jwks) ||
    !Array.isArray(jwks.keys) ||
    jwks.keys.length !== 1 ||
    !isJsonObject(jwks.keys[0])
  ) {
    throw new Error("issuer did not publish exactly one key");
  }
  const key = jwks.keys[0];
  expect(key.kty).toBe("RSA");
  expect(key.n).toEqual(expect.any(String));
  expect(key.e).toEqual(expect.any(String));
  for (const privateField of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
    expect(key).not.toHaveProperty(privateField);
  }
  return key;
}

describe("Identity test server", () => {
  it("serves the real issuer and supports SDK sessions and revocation", async () => {
    const identity = await startIdentityTestServer();
    try {
      const discovery = await fetch(
        `${identity.baseUrl}/.well-known/openid-configuration`,
      );
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        issuer: identity.baseUrl,
        jwks_uri: `${identity.baseUrl}/jwks`,
      });

      const client = createControlPlaneClient({ baseUrl: identity.baseUrl });
      const session = await client.createProvisionalSession();
      expect(await client.whoami()).toMatchObject({ id: session.principalId });

      // A fabricated principal id is not an authentication credential.
      const forged = await fetch(`${identity.baseUrl}/v1/principals/me`, {
        headers: { authorization: `Bearer ${session.principalId}` },
      });
      expect(forged.status).toBe(401);

      await client.logout();
      const replay = await fetch(`${identity.baseUrl}/v1/principals/me`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      expect(replay.status).toBe(401);
    } finally {
      await identity.close();
    }
    await identity.close();
    await expect(fetch(`${identity.baseUrl}/v1/health/live`)).rejects.toThrow();
  });

  it("keeps sessions isolated between independently started servers", async () => {
    await withTestResources(async (scope) => {
      const first = scope.use(await startIdentityTestServer());
      const second = scope.use(await startIdentityTestServer());
      const [firstKey, secondKey] = await Promise.all([
        publicSigningKey(first.baseUrl),
        publicSigningKey(second.baseUrl),
      ]);
      expect(firstKey.n).not.toBe(secondKey.n);
      const client = createControlPlaneClient({ baseUrl: first.baseUrl });
      const session = await client.createProvisionalSession();
      const foreign = await fetch(`${second.baseUrl}/v1/principals/me`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      expect(foreign.status).toBe(401);
      expect(await client.whoami()).toMatchObject({ id: session.principalId });
    });
  });

  it("uses an injected clock to expire sessions", async () => {
    let now = new Date();
    await withTestResources(async (scope) => {
      const identity = scope.use(
        await startIdentityTestServer({ clock: () => now }),
      );
      const client = createControlPlaneClient({ baseUrl: identity.baseUrl });
      await client.createProvisionalSession();
      expect(await client.authStatus()).toMatchObject({ authenticated: true });
      now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      expect(await client.authStatus()).toMatchObject({ authenticated: false });
    });
  });

  it("refuses ambient logging destinations and AgentAuth signing material", () => {
    for (const name of [
      "OPENSESAME_LOG_FILE",
      "OPENSESAME_LOG_KEY_FILE",
      "OPENSESAME_AGENT_AUTH_SIA_JWK",
      "OPENSESAME_JWKS_JSON",
    ]) {
      expect(() => assertIdentityTestEnvironment({ [name]: "set" })).toThrow(
        name,
      );
    }
    expect(() =>
      assertIdentityTestEnvironment({ NODE_ENV: "production" }),
    ).toThrow("production process");
    expect(() =>
      assertIdentityTestEnvironment({ NODE_ENV: "test" }),
    ).not.toThrow();
  });

  it("checks the ambient environment before starting a server", () => {
    const entry = new URL("./index.ts", import.meta.url).href;
    const script = `import { startIdentityTestServer } from ${JSON.stringify(entry)}; await startIdentityTestServer();`;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          OPENSESAME_LOG_FILE: "/this-test-must-not-open-a-log",
        },
        timeout: 25_000,
      },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(
      "Identity test server requires OPENSESAME_LOG_FILE to be unset",
    );
  }, 30_000);
});
