import { afterEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("postgres", () => ({ default: driver.connect }));

import { createPgTestContext } from "./pg-harness-full.js";

const base = "postgres://fixture:fixture@127.0.0.1:1/postgres";

afterEach(() => {
  driver.connect.mockReset();
  vi.unstubAllEnvs();
});

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
    it(`rejects ${suffix} before constructing the admin client`, async () => {
      vi.stubEnv("DATABASE_URL", `${base}${suffix}`);
      await expect(createPgTestContext()).rejects.toThrow(
        /must not (?:override|contain)/u,
      );
      expect(driver.connect).not.toHaveBeenCalled();
    });
  }

  it("rejects a fragment in the authority before postgres.js can reinterpret it", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://fixture:fixture@127.0.0.1:1#ignored?host=127.0.0.1&database=decoy",
    );
    await expect(createPgTestContext()).rejects.toThrow(/fragment/u);
    expect(driver.connect).not.toHaveBeenCalled();
  });

  it("rejects a non-Postgres scheme before constructing the admin client", async () => {
    vi.stubEnv("DATABASE_URL", "https://127.0.0.1/postgres");
    await expect(createPgTestContext()).rejects.toThrow(/Postgres URL scheme/u);
    expect(driver.connect).not.toHaveBeenCalled();
  });

  it("allows unrelated connection parameters", async () => {
    const stopped = new Error("stop before connecting");
    driver.connect.mockReturnValue({
      unsafe: async () => {
        throw stopped;
      },
      end: async () => undefined,
    });
    vi.stubEnv(
      "DATABASE_URL",
      `${base}?sslmode=require&application_name=fixture`,
    );
    await expect(createPgTestContext()).rejects.toBe(stopped);
    expect(driver.connect).toHaveBeenCalledOnce();
  });
});
