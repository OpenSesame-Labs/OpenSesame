import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

/** Pin matches ADR 0010 integration posture; refresh only with an explicit review. */
export const PINNED_POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e";

export type EphemeralPostgres = {
  databaseUrl: string;
  close: () => Promise<void>;
  /** Alias kept for existing callers. */
  stop: () => Promise<void>;
};

/**
 * Starts a disposable Postgres for integration tests when Docker is available.
 * Skip a suite only after establishing that Docker is unavailable. Propagate
 * image-pull, container startup, and other errors.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    PINNED_POSTGRES_IMAGE,
  ).start();
  let stopping: Promise<void> | undefined;
  const close = () => {
    stopping ??= container.stop().then(() => undefined);
    return stopping;
  };
  return {
    databaseUrl: container.getConnectionUri(),
    close,
    stop: close,
  };
}
