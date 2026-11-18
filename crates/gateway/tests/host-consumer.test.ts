import { describe, expect, it } from "vitest";
import { createApiClient } from "../../../packages/api-client/src/index.js";

const baseUrl = process.env.OPENSESAME_TEST_HOST_URL;
const token = process.env.OPENSESAME_TEST_HOST_OPERATOR;

function fixtureOrigin(raw: string): string {
  const url = URL.parse(raw);
  if (
    url?.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.origin !== raw
  ) {
    throw new Error("Host testkit URL must be a canonical loopback origin");
  }
  return url.origin;
}

function localFetch(origin: string, send: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = URL.parse(input instanceof Request ? input.url : String(input));
    if (!url || url.origin !== origin || url.username || url.password) {
      return Promise.reject(new Error("Host testkit request left loopback"));
    }
    return send(input, { ...init, redirect: "error" });
  };
}

describe("Host testkit consumer boundary", () => {
  it("rejects remote or noncanonical fixture origins", () => {
    for (const value of [
      "https://example.test",
      "http://localhost:1234",
      "http://127.0.0.1:1234/path",
      "http://user@127.0.0.1:1234",
      "http://127.0.0.1",
    ]) {
      expect(() => fixtureOrigin(value)).toThrow();
    }
  });

  it("refuses an off-origin request before fetch and disables redirects", async () => {
    let calls = 0;
    const send: typeof fetch = async (_input, init) => {
      calls += 1;
      expect(init?.redirect).toBe("error");
      return new Response("ok");
    };
    const fetchLocal = localFetch("http://127.0.0.1:1234", send);
    await expect(fetchLocal("https://example.test/", {})).rejects.toThrow();
    expect(calls).toBe(0);
    await fetchLocal("http://127.0.0.1:1234/health/live", {});
    expect(calls).toBe(1);
  });
});

describe.skipIf(!baseUrl || !token)("Host testkit with the API client", () => {
  it("uses the real Host routes and observes operator admission", async () => {
    if (!baseUrl || !token) throw new Error("Host testkit is not running");
    const origin = fixtureOrigin(baseUrl);
    const fetchImpl = localFetch(origin);
    const operator = createApiClient({
      baseUrl: origin,
      accessToken: `operator:${token}`,
      fetchImpl,
    });
    expect(await operator.health()).toEqual({ ok: true, body: "ok" });
    expect(await operator.whoami()).toMatchObject({
      authentication: "operator",
    });
    expect(await operator.listConnections()).toEqual({ connections: [] });

    const anonymous = createApiClient({ baseUrl: origin, fetchImpl });
    await expect(anonymous.listConnections()).rejects.toThrow(/401/u);
  });
});
