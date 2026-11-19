import { randomUUID } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  MemoryRepositories,
  NotFoundError,
} from "../src/index.js";
import {
  makeAuditEvent,
  makeClaim,
  makeClaimItem,
  makeIdentity,
  makePrincipal,
} from "./factories.js";

describe("MemoryRepositories.principals", () => {
  it("rejects duplicates and reports misses", async () => {
    const repos = new MemoryRepositories();
    const principal = makePrincipal();
    await repos.principals.create(principal);
    await expect(repos.principals.create(principal)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await repos.principals.getById(randomUUID())).toBeNull();
  });

  it("updates with optimistic concurrency and preserves identity fields", async () => {
    const repos = new MemoryRepositories();
    const created = await repos.principals.create(
      makePrincipal({ state: "provisional" }),
    );

    await expect(
      repos.principals.update(randomUUID(), { state: "active" }, 1),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repos.principals.update(created.id, { state: "active" }, 99),
    ).rejects.toBeInstanceOf(ConflictError);

    const stamped = new Date();
    const updated = await repos.principals.update(
      created.id,
      {
        state: "active",
        assurance: "verified",
        verifiedAt: stamped,
        updatedAt: stamped,
      },
      1,
    );
    expect(updated.version).toBe(2);
    expect(updated.state).toBe("active");
    expect(updated.createdAt).toEqual(created.createdAt);
    expect(updated.updatedAt).toEqual(stamped);
  });

  it("deletes only unlinked provisional principals, cascading better-auth links", async () => {
    const repos = new MemoryRepositories();
    expect(await repos.principals.deleteUnlinkedProvisional(randomUUID())).toBe(
      false,
    );

    const active = await repos.principals.create(
      makePrincipal({ state: "active" }),
    );
    expect(await repos.principals.deleteUnlinkedProvisional(active.id)).toBe(
      false,
    );

    const linked = await repos.principals.create(
      makePrincipal({ state: "provisional" }),
    );
    await repos.externalIdentities.create(makeIdentity(linked.id));
    expect(await repos.principals.deleteUnlinkedProvisional(linked.id)).toBe(
      false,
    );

    const provisional = await repos.principals.create(
      makePrincipal({ state: "provisional" }),
    );
    const betterAuthUserId = `ba_${randomUUID()}`;
    await repos.betterAuthSubjects.link({
      betterAuthUserId,
      principalId: provisional.id,
      linkedAt: new Date(),
    });
    expect(
      await repos.principals.deleteUnlinkedProvisional(provisional.id),
    ).toBe(true);
    expect(await repos.principals.getById(provisional.id)).toBeNull();
    // The better-auth link went with it.
    expect(
      await repos.betterAuthSubjects.getByBetterAuthUserId(betterAuthUserId),
    ).toBeNull();
  });
});

describe("MemoryRepositories.externalIdentities", () => {
  it("rejects a duplicate id even with a distinct tuple", async () => {
    const repos = new MemoryRepositories();
    const principal = await repos.principals.create(makePrincipal());
    const identity = makeIdentity(principal.id);
    await repos.externalIdentities.create(identity);
    await expect(
      repos.externalIdentities.create(
        makeIdentity(principal.id, { id: identity.id }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("stores tenantless identities without a tenant key and finds them by tuple", async () => {
    const repos = new MemoryRepositories();
    const principal = await repos.principals.create(makePrincipal());
    const identity = makeIdentity(principal.id);
    const created = await repos.externalIdentities.create(identity);
    expect("tenant" in created).toBe(false);

    const found = await repos.externalIdentities.findByTuple({
      kind: identity.kind,
      issuer: identity.issuer,
      subject: identity.subject,
    });
    expect(found?.id).toBe(identity.id);

    // A tenant-scoped query for the same triple is a different tuple.
    expect(
      await repos.externalIdentities.findByTuple({
        kind: identity.kind,
        issuer: identity.issuer,
        tenant: "acme",
        subject: identity.subject,
      }),
    ).toBeNull();
  });

  it("lists by principal and misses unknown ids", async () => {
    const repos = new MemoryRepositories();
    const a = await repos.principals.create(makePrincipal());
    const b = await repos.principals.create(makePrincipal());
    await repos.externalIdentities.create(makeIdentity(a.id));
    await repos.externalIdentities.create(makeIdentity(b.id));

    const listed = await repos.externalIdentities.listByPrincipal(a.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.principalId).toBe(a.id);
    expect(await repos.externalIdentities.getById(randomUUID())).toBeNull();
  });

  it("deletes by id, including inside a transaction", async () => {
    const repos = new MemoryRepositories();
    const principal = await repos.principals.create(makePrincipal());
    const identity = await repos.externalIdentities.create(
      makeIdentity(principal.id),
    );

    // Deferred through a unit of work: invisible until commit.
    await repos.transaction(async (uow) => {
      const pending = await repos.externalIdentities.deleteById(
        identity.id,
        uow,
      );
      expect(pending).toBe(true);
      expect(
        await repos.externalIdentities.getById(identity.id),
      ).not.toBeNull();
    });
    expect(await repos.externalIdentities.getById(identity.id)).toBeNull();
    expect(await repos.externalIdentities.deleteById(identity.id)).toBe(false);
  });

  it("does not leak stored metadata through returned copies", async () => {
    const repos = new MemoryRepositories();
    const principal = await repos.principals.create(makePrincipal());
    const created = await repos.externalIdentities.create(
      makeIdentity(principal.id, { metadata: { role: "admin" } }),
    );
    created.metadata.role = "mutated";
    const loaded = await repos.externalIdentities.getById(created.id);
    expect(loaded?.metadata).toEqual({ role: "admin" });
  });
});

describe("MemoryRepositories.betterAuthSubjects", () => {
  it("links once and rejects duplicates", async () => {
    const repos = new MemoryRepositories();
    const principal = await repos.principals.create(makePrincipal());
    const row = {
      betterAuthUserId: `ba_${randomUUID()}`,
      principalId: principal.id,
      linkedAt: new Date(),
    };
    expect(await repos.betterAuthSubjects.link(row)).toEqual(row);
    expect(
      await repos.betterAuthSubjects.getByBetterAuthUserId(
        row.betterAuthUserId,
      ),
    ).toEqual(row);
    await expect(repos.betterAuthSubjects.link(row)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("MemoryRepositories.claimSessions", () => {
  it("rejects duplicates and reports misses", async () => {
    const repos = new MemoryRepositories();
    const claim = makeClaim();
    await repos.claimSessions.create(claim);
    await expect(repos.claimSessions.create(claim)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await repos.claimSessions.getById(randomUUID())).toBeNull();
    await expect(
      repos.claimSessions.updateWithVersion(randomUUID(), 1, {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("copies token digests instead of aliasing caller buffers", async () => {
    const repos = new MemoryRepositories();
    const digest = new Uint8Array([1, 1, 1]);
    const created = await repos.claimSessions.create(
      makeClaim({ tokenDigest: digest }),
    );
    digest[0] = 99;
    const loaded = await repos.claimSessions.getById(created.id);
    expect(loaded?.tokenDigest).toEqual(new Uint8Array([1, 1, 1]));
  });

  it("keeps, replaces, and clears the user code digest", async () => {
    const repos = new MemoryRepositories();
    const created = await repos.claimSessions.create(
      makeClaim({ userCodeDigest: new Uint8Array([5]) }),
    );

    // Patch without the field: digest untouched.
    const kept = await repos.claimSessions.updateWithVersion(created.id, 1, {
      state: "presented",
    });
    expect(kept.userCodeDigest).toEqual(new Uint8Array([5]));

    // Patch with a value: replaced with a copy.
    const replacement = new Uint8Array([6]);
    const replaced = await repos.claimSessions.updateWithVersion(
      created.id,
      2,
      { userCodeDigest: replacement },
    );
    replacement[0] = 99;
    expect(replaced.userCodeDigest).toEqual(new Uint8Array([6]));

    // Patch with a falsy non-undefined value: cleared from the row.
    const cleared = await repos.claimSessions.updateWithVersion(created.id, 3, {
      userCodeDigest: overlapCast(null),
    });
    expect("userCodeDigest" in cleared).toBe(false);
    const loaded = await repos.claimSessions.getById(created.id);
    expect("userCodeDigest" in (loaded ?? {})).toBe(false);
  });
});

describe("MemoryRepositories.claimItems", () => {
  it("creates items, rejects duplicates, and lists by claim with copies", async () => {
    const repos = new MemoryRepositories();
    const claimId = randomUUID();
    const item = makeClaimItem(claimId, { dependencies: ["dep-1"] });
    const created = await repos.claimItems.create(item);
    expect(created).toEqual(item);
    await expect(repos.claimItems.create(item)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await repos.claimItems.create(makeClaimItem(randomUUID()));

    created.dependencies.push("mutated");
    const listed = await repos.claimItems.listByClaim(claimId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.dependencies).toEqual(["dep-1"]);
  });
});

describe("MemoryRepositories.auditEvents", () => {
  it("keeps audit event IDs and chain predecessors insert-only", async () => {
    const repos = new MemoryRepositories();
    const event = makeAuditEvent({
      previousDigest: "genesis",
      digest: "first",
    });
    await repos.auditEvents.append(event);
    await expect(
      repos.auditEvents.append({ ...event, metadata: { note: "replacement" } }),
    ).rejects.toMatchObject({ code: "23505", constraint: "audit_events_pkey" });
    await expect(
      repos.auditEvents.append(
        makeAuditEvent({ previousDigest: "genesis", digest: "branch" }),
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "audit_events_previous_digest_uidx",
    });
    expect(await repos.auditEvents.getById(event.id)).toEqual(event);
  });

  it("lists newest first with principal filter, limit, and copies", async () => {
    const repos = new MemoryRepositories();
    const principalId = `prn_${randomUUID()}`;
    for (const eventType of ["ev_0", "ev_1", "ev_2"]) {
      await repos.auditEvents.append(
        makeAuditEvent({ principalId, eventType }),
      );
    }
    await repos.auditEvents.append(makeAuditEvent({ eventType: "other" }));

    const all = await repos.auditEvents.list({ principalId });
    expect(all.map((e) => e.eventType)).toEqual(["ev_2", "ev_1", "ev_0"]);

    const limited = await repos.auditEvents.list({ principalId, limit: 2 });
    expect(limited).toHaveLength(2);

    const unfiltered = await repos.auditEvents.list();
    expect(unfiltered.length).toBeGreaterThanOrEqual(4);

    const [first] = all;
    if (!first) throw new Error("missing audit row");
    first.metadata.injected = true;
    const reread = await repos.auditEvents.list({ principalId, limit: 1 });
    expect(reread[0]?.metadata).toEqual({});
  });
});
