import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/repos/errors.js";
import { MemoryRepositories } from "../src/repos/memory.js";
import { makeIdentity, makePrincipal } from "./factories.js";

/**
 * Tuple uniqueness under deferred memory inserts (Codex review, PR #2551).
 *
 * The memory backend defers a unit-of-work insert to commit, so the
 * call-time uniqueness check cannot see a concurrent transaction that
 * commits the same tuple first. Without a commit-time recheck both rows
 * landed and tuple lookups silently retargeted to the last writer — a
 * fence Postgres gets from its unique index.
 */
describe("memory external identities under concurrent transactions", () => {
  it("rejects the second commit of the same tuple instead of retargeting lookups", async () => {
    const repos = new MemoryRepositories();
    const first = makePrincipal();
    const second = makePrincipal();
    await repos.principals.create(first);
    await repos.principals.create(second);
    const tuple = {
      kind: "oidc",
      issuer: "https://idp.example",
      subject: "shared-subject",
    } as const;
    const firstIdentity = makeIdentity(first.id, tuple);
    const secondIdentity = makeIdentity(second.id, tuple);

    // Hold the first transaction open after its (deferred) insert so the
    // second transaction passes its own call-time check too.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstTx = repos.transaction(async (uow) => {
      await repos.externalIdentities.create(firstIdentity, uow);
      await gate;
    });
    const secondTx = repos.transaction(async (uow) => {
      await repos.externalIdentities.create(secondIdentity, uow);
    });
    // Whichever commits first wins; the other must conflict at commit.
    release();
    const settled = await Promise.allSettled([firstTx, secondTx]);
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]?.status === "rejected" ? rejected[0].reason : null,
    ).toBeInstanceOf(ConflictError);

    const winner =
      settled[0]?.status === "fulfilled" ? firstIdentity : secondIdentity;
    const found = await repos.externalIdentities.findByTuple(tuple);
    expect(found?.id).toBe(winner.id);
    expect(found?.principalId).toBe(winner.principalId);
    const loserPrincipal = winner === firstIdentity ? second : first;
    expect(
      await repos.externalIdentities.listByPrincipal(loserPrincipal.id),
    ).toHaveLength(0);
  });

  it("strands none of the losing transaction's earlier writes", async () => {
    // Registration-shaped caller (agent-auth-id-jag-persist): a principal
    // create is queued before the identity insert. Conflicts are
    // validated before any deferred write applies, so when the tuple is
    // lost to a concurrent commit the whole transaction is rejected —
    // the queued principal must not persist.
    const repos = new MemoryRepositories();
    const winner = makePrincipal();
    await repos.principals.create(winner);
    const tuple = {
      kind: "oidc",
      issuer: "https://idp.example",
      subject: "raced-subject",
    } as const;

    const loserPrincipal = makePrincipal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const losingTx = repos.transaction(async (uow) => {
      await repos.principals.create(loserPrincipal, uow);
      await repos.externalIdentities.create(
        makeIdentity(loserPrincipal.id, tuple),
        uow,
      );
      await gate;
    });
    await repos.transaction(async (uow) => {
      await repos.externalIdentities.create(
        makeIdentity(winner.id, tuple),
        uow,
      );
    });
    release();
    await expect(losingTx).rejects.toBeInstanceOf(ConflictError);
    expect(await repos.principals.getById(loserPrincipal.id)).toBeNull();
    expect(
      await repos.externalIdentities.listByPrincipal(loserPrincipal.id),
    ).toHaveLength(0);
  });

  it("allows deleting and recreating a tuple in one transaction", async () => {
    const repos = new MemoryRepositories();
    const first = makePrincipal();
    const second = makePrincipal();
    await repos.principals.create(first);
    await repos.principals.create(second);
    const tuple = {
      kind: "oidc",
      issuer: "https://idp.example",
      subject: "moved-subject",
    } as const;
    const original = makeIdentity(first.id, tuple);
    await repos.externalIdentities.create(original);

    const replacement = makeIdentity(second.id, tuple);
    await repos.transaction(async (uow) => {
      await repos.externalIdentities.deleteById(original.id, uow);
      await repos.externalIdentities.create(replacement, uow);
    });
    const found = await repos.externalIdentities.findByTuple(tuple);
    expect(found?.id).toBe(replacement.id);
    expect(found?.principalId).toBe(second.id);
  });

  it("still rejects a duplicate tuple outside any transaction", async () => {
    const repos = new MemoryRepositories();
    const principal = makePrincipal();
    await repos.principals.create(principal);
    const tuple = {
      kind: "oidc",
      issuer: "https://idp.example",
      subject: "solo-subject",
    } as const;
    await repos.externalIdentities.create(makeIdentity(principal.id, tuple));
    await expect(
      repos.externalIdentities.create(makeIdentity(principal.id, tuple)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
