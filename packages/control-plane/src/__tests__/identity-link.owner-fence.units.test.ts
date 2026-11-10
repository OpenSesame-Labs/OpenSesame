import { beforeEach, describe, expect, it } from "vitest";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import {
  type Fakes,
  INPUT,
  identity,
  makeFakes,
  principal,
} from "./identity-link-fakes.js";

/**
 * The verified-email join lands an identity on SOMEONE ELSE's principal, so
 * it is fenced on that owner's state before, during and after the write.
 */

let f: Fakes;

beforeEach(() => {
  f = makeFakes();
});

describe("the verified-email join is fenced on the owner", () => {
  it("refuses the verified-email join before writing anything when the road forbids it", async () => {
    // Chair gauntlet round 3: an authenticated link road acting for a
    // durable caller must not silently merge onto the address's owner.
    // The fence refuses ahead of the write — no row lands anywhere.
    f.principals.set(
      "prn_someone_else",
      principal({
        id: "prn_someone_else",
        state: "active",
        assurance: "verified",
      }),
    );
    f.identities.push(
      identity({
        id: "xid_other",
        principalId: "prn_someone_else",
        subject: "a-different-subject",
        emailNormalized: "person@example.com",
        emailVerified: true,
      }),
    );

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
      emailVerified: true,
      joinByVerifiedEmail: false,
    });

    expect(result).toMatchObject({ ok: false, error: "identity_collision" });
    expect(f.created).toHaveLength(0);
  });

  it("refuses the verified-email join before writing anything when the owner is suspended", async () => {
    // Gauntlet round 4 (grok/opencode/kimi): the adoption roads refuse a
    // non-active owner, but the attach wrote the identity row onto that
    // owner first and the route still answered 201 with its id. The fence
    // belongs ahead of the write, at the admission chokepoint.
    f.principals.set(
      "prn_someone_else",
      principal({
        id: "prn_someone_else",
        state: "suspended",
        assurance: "verified",
      }),
    );
    f.identities.push(
      identity({
        id: "xid_other",
        principalId: "prn_someone_else",
        subject: "a-different-subject",
        emailNormalized: "person@example.com",
        emailVerified: true,
      }),
    );

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
      emailVerified: true,
    });

    expect(result).toMatchObject({ ok: false, error: "identity_collision" });
    expect(f.created).toHaveLength(0);
  });

  it("does not leave the join written when the owner is suspended during the write", async () => {
    // Gauntlet round 5: the pre-write state read and the identity insert
    // are separate awaits. A suspension landing between them must not
    // leave a fresh identity bound to a dead principal or report success.
    f.principals.set(
      "prn_someone_else",
      principal({
        id: "prn_someone_else",
        state: "active",
        assurance: "verified",
      }),
    );
    f.identities.push(
      identity({
        id: "xid_other",
        principalId: "prn_someone_else",
        subject: "a-different-subject",
        emailNormalized: "person@example.com",
        emailVerified: true,
      }),
    );
    f.createImpl = async (record) => {
      f.principals.set(
        "prn_someone_else",
        principal({
          id: "prn_someone_else",
          state: "suspended",
          assurance: "verified",
          version: 2,
        }),
      );
      return record;
    };

    const result = await attachVerifiedExternalIdentity(f.ctx, "prn_1", {
      ...INPUT,
      emailNormalized: "person@example.com",
      emailVerified: true,
    });

    expect(result).toMatchObject({ ok: false, error: "identity_collision" });
    expect(
      f.identities.filter((row) => row.subject === INPUT.subject),
    ).toHaveLength(0);
    expect(
      f.audits.filter((a) => a.eventType === "principal.identity_linked"),
    ).toHaveLength(0);
  });
});
