import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { ConflictError, type UnitOfWork } from "@opensesame/database";
import type { ExternalIdentity } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/**
 * Canonical binding of a *verified* upstream identity to a principal.
 *
 * Extracted verbatim from the `POST /v1/principals/link-identities` handler so
 * the server-side relying-party leg (hosted "Sign in with Google") and the
 * agent-facing id_token link path share one implementation of the same rules.
 * Every other admission leg has since joined them: the generic OAuth2 leg, the
 * SAML SP, LDAP bind and email magic-link all land here, which is why `kind`
 * is an input rather than a constant.
 *
 * The caller owns verification: by the time this runs the assertion has already
 * passed issuer allowlisting and whatever proof its protocol defines — a
 * JWKS-verified id_token, a signed SAML assertion, or an authenticated read of
 * the provider's userinfo document.
 */

/**
 * SECURITY INVARIANT (ADR 0033 / ADR 0042 / ADR 0057): the tuple is the key;
 * a *verified* email is the only secondary join.
 *
 * An identity is looked up and matched by `(kind, issuer, tenant, subject)`
 * and nothing else. When that misses, and only then, ADR 0057 allows one
 * further question: does an existing principal already own a **verified**
 * identity carrying this same normalized email, asserted as verified on THIS
 * sign-in? If so the new identity attaches to that principal instead of
 * minting a duplicate account for the same human (D15).
 *
 * An *unverified* email is still never a join key. An upstream that lets a
 * user type an arbitrary address would otherwise be an account-takeover path,
 * so an unverified address only ever produces the *denied*
 * `principal.identity_link_email_collision` audit event and then links
 * normally by tuple — evidence for humans, not a matching rule. This is why
 * `external_identities.email_normalized` is indexed but deliberately NOT
 * unique, and why `findVerifiedByEmail` resolves duplicates deterministically
 * in code (oldest owning principal wins) rather than by a constraint.
 *
 * This attaches an identity at admission. It never fuses two already-durable
 * principals — that is `principal.merge`, which stays behind the policy fence.
 */

export type AttachIdentityKind = "oidc" | "oauth2" | "saml" | "ldap" | "email";

export type AttachIdentityInput = {
  /** Defaults to `"oidc"` — the tuple lookup AND the stored row use it. */
  kind?: AttachIdentityKind;
  issuer: string;
  /**
   * Tenant the identity namespace belongs to, when the issuer string alone is
   * not globally unique. SAML entityIDs are tenant-asserted, so two
   * organizations can name the same entityID; scoping by organization keeps a
   * forged assertion in one tenant from resolving another tenant's principal.
   */
  tenant?: string;
  subject: string;
  correlationId: string;
  displayHint?: string;
  emailNormalized?: string;
  emailVerified?: boolean;
  /**
   * Whether a verified-email match may land this identity on the OTHER
   * principal that owns the address (D15). Defaults to true — the admission
   * legs call with a just-minted provisional that exists to be bound. An
   * authenticated link road acting for a durable caller passes false: for
   * them the same landing is a merge, and merging takes dual authentication,
   * so the attach refuses with `identity_collision` instead of fusing.
   */
  joinByVerifiedEmail?: boolean;
  /** Provenance for the identity row, e.g. `{ nameIdFormat }` for SAML. */
  metadata?: Record<string, string>;
};

/**
 * What vouched for the subject, per identity kind (C5). Recorded on the audit
 * row because "an identity was linked" without saying what authorised it is
 * the one thing an investigator cannot reconstruct afterwards.
 */
const AUDIT_VIA_BY_KIND = {
  oidc: "id_token",
  oauth2: "userinfo",
  saml: "saml_assertion",
  ldap: "ldap_bind",
  email: "email_magic_link",
} satisfies Record<AttachIdentityKind, string>;

export type AttachIdentityResult =
  | { ok: true; alreadyLinked: boolean; identity: ExternalIdentity }
  | { ok: false; error: "identity_collision"; message: string };

/**
 * Deliberately does not name the bound principal id: echoing it would let any
 * caller enumerate which principal owns an upstream identity.
 */
const IDENTITY_COLLISION_MESSAGE =
  "External identity already bound to another principal; merge requires dual authentication";

/**
 * Whether the principal a verified identity belongs to may be signed in as,
 * promoting a leftover provisional record first.
 *
 * A verified tuple can outlive the promotion that was supposed to follow
 * its creation (a crash or a lost update race between the two writes).
 * The assertion that just verified is the same proof the original attach
 * would have promoted on, so a returning sign-in finishes that promotion
 * instead of either signing in as a provisional principal or stranding a
 * verified owner forever. Suspended, closed and missing principals are
 * never promoted or admitted.
 */
export async function ensureVerifiedIdentityPrincipalActive(
  ctx: AppContext,
  principalId: string,
  uow?: UnitOfWork,
): Promise<boolean> {
  const principal = await ctx.repos.principals.getById(principalId);
  if (
    !principal ||
    principal.state === "suspended" ||
    principal.state === "closed"
  ) {
    return false;
  }
  if (
    principal.state !== "provisional" &&
    principal.assurance !== "provisional"
  ) {
    return principal.state === "active";
  }
  const now = ctx.clock();
  try {
    const updated = await ctx.repos.principals.update(
      principalId,
      {
        state: "active",
        assurance: "verified",
        verifiedAt: now,
        updatedAt: now,
      },
      principal.version,
      uow,
    );
    return updated.state === "active" && updated.assurance !== "provisional";
  } catch (err) {
    if (err instanceof ConflictError) {
      const current = await ctx.repos.principals.getById(principalId);
      return current?.state === "active" && current.assurance !== "provisional";
    }
    throw err;
  }
}

/**
 * Bind a verified upstream identity to `principalId`.
 *
 * - idempotent when the same principal already owns the tuple
 *   (`{ ok: true, alreadyLinked: true }`)
 * - refuses when another principal owns it (`identity_collision`)
 * - promotes a provisional principal IN PLACE to active/verified; the
 *   principal id never changes, so a guest keeps everything it created.
 * - attaches to the principal that already owns this **verified** email, when
 *   there is one (D15) — the returned `identity.principalId` is therefore the
 *   authoritative owner, and callers that just minted a provisional principal
 *   must bind the session to THAT id rather than to the one they passed in.
 */
export async function attachVerifiedExternalIdentity(
  ctx: AppContext,
  principalId: string,
  input: AttachIdentityInput,
): Promise<AttachIdentityResult> {
  const kind = input.kind ?? "oidc";
  const via = AUDIT_VIA_BY_KIND[kind];
  // `tenant` is intentionally omitted: the repositories normalize an absent
  // tenant to "" for both the lookup key and the stored row.
  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind,
    issuer: input.issuer,
    ...(input.tenant !== undefined ? { tenant: input.tenant } : undefined),
    subject: input.subject,
  });
  if (existing) {
    if (existing.principalId === principalId) {
      return { ok: true, alreadyLinked: true, identity: existing };
    }
    return {
      ok: false,
      error: "identity_collision",
      message: IDENTITY_COLLISION_MESSAGE,
    };
  }

  /*
   * The verified-email auto-link (D15 / ADR 0057).
   *
   * Consulted only when THIS sign-in asserts the email as verified: the stored
   * side is already restricted to verified identities by the repository, and
   * requiring both ends means a provider that hands out unverified addresses
   * cannot reach an existing account at all. A match owned by the caller is no
   * match — there is nothing to move — so it falls through to the unchanged
   * collision-audit path below.
   */
  const emailMatch =
    input.emailVerified === true && input.emailNormalized
      ? await ctx.repos.externalIdentities.findVerifiedByEmail(
          input.emailNormalized,
        )
      : null;
  const emailOwner =
    emailMatch && emailMatch.principalId !== principalId
      ? emailMatch
      : undefined;
  if (emailOwner && input.joinByVerifiedEmail === false) {
    return {
      ok: false,
      error: "identity_collision",
      message: IDENTITY_COLLISION_MESSAGE,
    };
  }
  if (emailOwner) {
    // The adoption roads refuse a suspended or closed owner, but they run
    // after this write: without the same fence here, the identity lands on
    // a dead principal and the caller is still told it linked. A
    // provisional owner is not refused — the promotion below makes it
    // active in this same call, which is what adoption then reads.
    const owner = await ctx.repos.principals.getById(emailOwner.principalId);
    if (!owner || owner.state === "suspended" || owner.state === "closed") {
      return {
        ok: false,
        error: "identity_collision",
        message: IDENTITY_COLLISION_MESSAGE,
      };
    }
  }
  const ownerPrincipalId = emailOwner ? emailOwner.principalId : principalId;

  // Same email on another principal must never auto-link. Audit and continue.
  if (!emailOwner && input.emailNormalized) {
    const emailPeers = await ctx.repos.externalIdentities.listByEmailNormalized(
      input.emailNormalized,
    );
    const foreign = emailPeers.find((e) => e.principalId !== principalId);
    if (foreign) {
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "principal.identity_link_email_collision",
        outcome: "denied",
        principalId,
        correlationId: input.correlationId,
        metadata: {
          action: "principal.link_identity",
          note: "email_not_used_for_link",
        },
      });
    }
  }

  const now = ctx.clock();
  const identity: ExternalIdentity = {
    id: `xid_${randomUUID()}`,
    principalId: ownerPrincipalId,
    kind,
    issuer: input.issuer,
    ...(input.tenant !== undefined ? { tenant: input.tenant } : undefined),
    subject: input.subject,
    assurance: "verified",
    linkedAt: now,
    metadata: { ...input.metadata },
    ...(input.displayHint !== undefined
      ? { displayHint: input.displayHint }
      : undefined),
    ...(input.emailNormalized !== undefined
      ? { emailNormalized: input.emailNormalized }
      : undefined),
    ...(input.emailVerified !== undefined
      ? { emailVerified: input.emailVerified }
      : undefined),
  };
  try {
    // The row and its owner's promotion commit together: a crash between
    // the two writes used to leave a verified tuple on a provisional
    // principal. The owner is re-read inside the transaction because the
    // pre-write fence cannot see a suspension that lands while the insert
    // is in flight; refusing here rolls the new row back out with it.
    await ctx.repos.transaction(async (uow) => {
      await ctx.repos.externalIdentities.create(identity, uow);
      const target = await ctx.repos.principals.getById(ownerPrincipalId);
      // A self-attach whose principal row is already gone keeps the old
      // tolerant answer (the row is the caller's own; there is no owner
      // to protect and the FK has the last word in real repositories).
      // An email join onto SOMEONE ELSE never gets that tolerance.
      if (
        (target !== null || emailOwner !== undefined) &&
        !(await ensureVerifiedIdentityPrincipalActive(
          ctx,
          ownerPrincipalId,
          uow,
        ))
      ) {
        throw new ConflictError(IDENTITY_COLLISION_MESSAGE);
      }
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      // Real repositories roll the transaction back; a repository that
      // applied the insert before reporting the conflict gets the same
      // answer by hand. The id is this call's own UUID, so this can never
      // remove the row another request won the race with.
      await ctx.repos.externalIdentities
        .deleteById(identity.id)
        .catch(() => false);
      return { ok: false, error: "identity_collision", message: err.message };
    }
    throw err;
  }

  // A suspension can still land after the in-transaction read and before
  // the commit becomes visible here. Success is only reported for an
  // owner that is active at the moment this call settles; anything else
  // unbinds the fresh row and refuses, and the callers' own final state
  // checks cover a suspension after even this read.
  const settled = await ctx.repos.principals.getById(ownerPrincipalId);
  if (
    (settled === null && emailOwner !== undefined) ||
    (settled !== null &&
      (settled.state !== "active" || settled.assurance === "provisional"))
  ) {
    await ctx.repos.externalIdentities.deleteById(identity.id);
    return {
      ok: false,
      error: "identity_collision",
      message: IDENTITY_COLLISION_MESSAGE,
    };
  }

  if (emailOwner) {
    /*
     * Why this principal and not the caller's. `issuer` and `kind` here name
     * the identity that ALREADY owned the address; the new identity's own
     * issuer and kind are on the `principal.identity_linked` event emitted
     * next, which carries the same targetId and correlationId, so one
     * correlation id yields both ends of the join.
     *
     * (The audit metadata allowlist in `packages/audit` has a single `issuer`
     * key and is another swarm's file, so the two issuers travel as two events
     * rather than two keys on one.)
     */
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.identity_email_linked",
      outcome: "succeeded",
      principalId: ownerPrincipalId,
      targetType: "external_identity",
      targetId: identity.id,
      correlationId: input.correlationId,
      metadata: {
        action: "principal.link_identity",
        kind: emailOwner.kind,
        issuer: emailOwner.issuer,
        via,
        note: "matched_verified_email",
      },
    });
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "principal.identity_linked",
    outcome: "succeeded",
    principalId: ownerPrincipalId,
    targetType: "external_identity",
    targetId: identity.id,
    correlationId: input.correlationId,
    metadata: {
      action: "principal.link_identity",
      kind: identity.kind,
      issuer: identity.issuer,
      via,
    },
  });

  return { ok: true, alreadyLinked: false, identity };
}
