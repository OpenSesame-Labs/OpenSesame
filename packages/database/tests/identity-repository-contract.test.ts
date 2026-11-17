import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  MemoryRepositories,
  type Repositories,
} from "../src/index.js";
import { makeIdentity, makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * Identity registration must behave the same through the in-memory and SQL
 * repository ports. The SQL fixture uses migrated PGlite by default; setting
 * DATABASE_URL runs this same contract on a disposable real Postgres database.
 */
let pg: PgTestContext | undefined;
beforeAll(async () => {
  pg = await createPgTestContext();
}, 60_000);
afterAll(async () => {
  await pg?.client.close();
});

interface Backend {
  name: string;
  repos(): Repositories;
}

const backends: Backend[] = [
  { name: "memory", repos: () => new MemoryRepositories() },
  {
    name: "SQL",
    repos: () => {
      if (!pg) throw new Error("SQL fixture did not start");
      return pg.repos;
    },
  },
];

describe.each(backends)("$name Identity repository contract", (backend) => {
  it("contract: identity tuples distinguish tenants and cannot be retargeted", async () => {
    const repos = backend.repos();
    const first = await repos.principals.create(makePrincipal());
    const second = await repos.principals.create(makePrincipal());
    const tuple = {
      kind: "oidc",
      issuer: "https://issuer.example",
      subject: randomUUID(),
    } as const;
    const firstIdentity = await repos.externalIdentities.create(
      makeIdentity(first.id, tuple),
    );

    // An omitted tenant and an empty tenant address the same identity.
    expect(
      await repos.externalIdentities.findByTuple({ ...tuple, tenant: "" }),
    ).toMatchObject({ id: firstIdentity.id, principalId: first.id });
    await expect(
      repos.externalIdentities.create(
        makeIdentity(second.id, { ...tuple, tenant: "" }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const secondIdentity = await repos.externalIdentities.create(
      makeIdentity(second.id, { ...tuple, tenant: "tenant-b" }),
    );
    expect(await repos.externalIdentities.findByTuple(tuple)).toMatchObject({
      id: firstIdentity.id,
      principalId: first.id,
    });
    expect(
      await repos.externalIdentities.findByTuple({
        ...tuple,
        tenant: "tenant-b",
      }),
    ).toMatchObject({ id: secondIdentity.id, principalId: second.id });
    expect(
      await repos.externalIdentities.findByTuple({
        ...tuple,
        tenant: "tenant-c",
      }),
    ).toBeNull();
    expect(
      await repos.externalIdentities.listByPrincipal(first.id),
    ).toHaveLength(1);
    expect(
      await repos.externalIdentities.listByPrincipal(second.id),
    ).toMatchObject([{ id: secondIdentity.id }]);
  });

  it("contract: failed registration rolls back identity, principal, and outbox before retry", async () => {
    const repos = backend.repos();
    const principal = makePrincipal();
    const identity = makeIdentity(principal.id);
    const event = {
      id: `ob_${randomUUID()}`,
      aggregateType: "principal",
      aggregateId: principal.id,
      eventType: "principal.created",
      payload: {},
    };

    await expect(
      repos.transaction(async (uow) => {
        await repos.principals.create(principal, uow);
        await repos.externalIdentities.create(identity, uow);
        await uow.appendOutbox(event);
        throw new Error("abort registration");
      }),
    ).rejects.toThrow("abort registration");
    expect(await repos.principals.getById(principal.id)).toBeNull();
    expect(await repos.externalIdentities.getById(identity.id)).toBeNull();
    expect(
      (await repos.outbox.listUnpublished(1000)).some(
        (row) => row.id === event.id,
      ),
    ).toBe(false);

    await repos.transaction(async (uow) => {
      await repos.principals.create(principal, uow);
      await repos.externalIdentities.create(identity, uow);
      await uow.appendOutbox(event);
    });
    expect(await repos.principals.getById(principal.id)).toMatchObject({
      id: principal.id,
    });
    expect(await repos.externalIdentities.getById(identity.id)).toMatchObject({
      principalId: principal.id,
    });
    expect(
      (await repos.outbox.listUnpublished(1000)).filter(
        (row) => row.id === event.id,
      ),
    ).toHaveLength(1);
  });

  it("adversarial: competing registrations cannot share an upstream identity", async () => {
    const repos = backend.repos();
    const tuple = {
      kind: "oidc",
      issuer: "https://issuer.example",
      subject: randomUUID(),
    } as const;
    const candidates = [makePrincipal(), makePrincipal()].map((principal) => ({
      principal,
      identity: makeIdentity(principal.id, tuple),
      eventId: `ob_${randomUUID()}`,
    }));
    const outcomes = await Promise.allSettled(
      candidates.map((candidate) =>
        repos.transaction(async (uow) => {
          await repos.principals.create(candidate.principal, uow);
          await repos.externalIdentities.create(candidate.identity, uow);
          await uow.appendOutbox({
            id: candidate.eventId,
            aggregateType: "principal",
            aggregateId: candidate.principal.id,
            eventType: "principal.created",
            payload: {},
          });
        }),
      ),
    );
    const wins = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losses = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.reason).toBeInstanceOf(ConflictError);

    const winnerIndex = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    const winner = candidates[winnerIndex];
    const loser = candidates[1 - winnerIndex];
    if (!winner || !loser) throw new Error("registration outcome missing");
    expect(await repos.externalIdentities.findByTuple(tuple)).toMatchObject({
      id: winner.identity.id,
      principalId: winner.principal.id,
    });
    expect(await repos.principals.getById(loser.principal.id)).toBeNull();
    expect(
      await repos.externalIdentities.getById(loser.identity.id),
    ).toBeNull();
    const unpublished = await repos.outbox.listUnpublished(1000);
    expect(unpublished.some((row) => row.id === winner.eventId)).toBe(true);
    expect(unpublished.some((row) => row.id === loser.eventId)).toBe(false);
  });
});
