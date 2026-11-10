import type { OrganizationAuthMethodKind } from "@opensesame/contracts";
import type { AppContext } from "../context.js";
import { emailLinkFields } from "../services/email-authority.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { settleVerifiedOwner } from "../services/identity-principal-fence.js";
import type { VerifiedOrgIdToken } from "./org-assertion.js";

export type OrgJoinIdentity =
  | { ok: true; memberPrincipalId: string }
  | { ok: false; status: 403 | 409; error: string; message: string };

/**
 * Bind the asserted subject to the caller before anything is granted. A
 * collision means the identity belongs to a different principal; the
 * message deliberately does not name it (federated-signin.md §7.6).
 *
 * Verified-email auto-link (ADR 0057 D15) can store the new identity on a
 * different principal than the caller. Membership follows that owner, the
 * same way hosted SSO, LDAP, and SAML do, so the owner is what comes back —
 * and only while that owner may still be signed in as.
 */
export async function bindOrgJoinIdentity(
  ctx: AppContext,
  principalId: string,
  input: {
    organizationId: string;
    issuer: string;
    method: OrganizationAuthMethodKind;
    assertion: VerifiedOrgIdToken;
    correlationId: string;
  },
): Promise<OrgJoinIdentity> {
  const { assertion, issuer } = input;
  const attached = await attachVerifiedExternalIdentity(ctx, principalId, {
    issuer,
    subject: assertion.sub,
    correlationId: input.correlationId,
    ...(assertion.name !== undefined
      ? { displayHint: assertion.name }
      : undefined),
    // The tenant's own IdP asserted this address. It joins accounts only
    // for a domain the organization proved it controls, the same rule the
    // SAML and directory legs use — an owner may speak for their own
    // namespace, not for `@gmail.com` (ADR 0057 §6).
    ...(await emailLinkFields(
      ctx,
      {
        source: "org",
        organizationId: input.organizationId,
        issuer,
        method: input.method === "saml" ? "saml" : "sso",
      },
      assertion.email,
      assertion.emailVerified,
    )),
  });
  if (!attached.ok) {
    return {
      ok: false,
      status: 409,
      error: attached.error,
      message: attached.message,
    };
  }
  const memberPrincipalId = attached.identity.principalId;
  if (!(await settleVerifiedOwner(ctx, memberPrincipalId))) {
    return {
      ok: false,
      status: 403,
      error: "principal_inactive",
      message: "This account is not able to sign in.",
    };
  }
  return { ok: true, memberPrincipalId };
}
