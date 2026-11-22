import { overlapCast } from "@opensesame/os-domain";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { describe, expect, it, vi } from "vitest";
import {
  PINNED_POSTGRES_IMAGE,
  startEphemeralPostgres,
} from "./postgres-testcontainer.js";

describe("postgres testcontainer defaults", () => {
  it("pins the postgres image by digest", () => {
    expect(PINNED_POSTGRES_IMAGE).toMatch(
      /^postgres:16-alpine@sha256:[a-f0-9]{64}$/u,
    );
  });

  it("returns the adapter connection URI and stops once for concurrent cleanup", async () => {
    const stop = vi.fn(async () => undefined);
    const getConnectionUri = vi.fn(
      () => "postgres://test:test@127.0.0.1:15432/test",
    );
    const container = {
      getConnectionUri,
      stop,
    };
    const start = vi
      .spyOn(PostgreSqlContainer.prototype, "start")
      .mockImplementation(async () => {
        // The adapter only calls these two methods in this fixture.
        const started: StartedPostgreSqlContainer = overlapCast(container);
        return started;
      });
    try {
      const result = await startEphemeralPostgres();
      expect(result.databaseUrl).toBe(
        "postgres://test:test@127.0.0.1:15432/test",
      );
      await Promise.all([result.close(), result.stop(), result.close()]);
      expect(start).toHaveBeenCalledTimes(1);
      expect(getConnectionUri).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
    }
  });
});
