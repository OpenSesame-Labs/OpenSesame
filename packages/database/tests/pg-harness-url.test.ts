import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgTestContext } from "./pg-harness-full.js";

// No PostgreSQL server is expected on this synthetic loopback endpoint.
const base = "postgres://fixture:fixture@127.0.0.1:1/postgres";

afterEach(() => vi.unstubAllEnvs());

describe("real Postgres test URL admission", () => {
  for (const suffix of [
    "?database=decoy",
    "?database=",
    "?DATABASE=decoy",
    "?%64atabase=decoy",
    "?datab%61se=decoy",
    "?database=first&database=second",
    "?application_name=fixture&%64atabase=decoy",
    "?dbname=decoy",
    "?DB=decoy",
    "#ignored?host=127.0.0.1&database=decoy",
    "?application_name=fixture#fragment",
  ]) {
    it(`rejects ${suffix} before attempting a connection`, async () => {
      vi.stubEnv("DATABASE_URL", `${base}${suffix}`);
      await expect(createPgTestContext()).rejects.toThrow(
        /must not (?:override|contain)/u,
      );
    });
  }

  it("rejects a fragment in the authority before postgres.js can reinterpret it", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://fixture:fixture@127.0.0.1:1#ignored?host=127.0.0.1&database=decoy",
    );
    await expect(createPgTestContext()).rejects.toThrow(/fragment/u);
  });

  it("rejects a non-Postgres scheme", async () => {
    vi.stubEnv("DATABASE_URL", "https://127.0.0.1/postgres");
    await expect(createPgTestContext()).rejects.toThrow(/Postgres URL scheme/u);
  });
});
