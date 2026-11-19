import { randomUUID } from "node:crypto";
import type { ScimUserRecord } from "@opensesame/database";
import type { Organization, OrganizationRole } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  prepareDirectoryRemoval,
  removeDirectoryMembership,
} from "./directory-removal.js";
import { serializeMembershipMutation } from "./organizations.js";

/**
 * Where a Groups PATCH records the derived role, on the SCIM row itself.
 * Stripped from every representation this route renders.
 */
export const SCIM_ROLE_ATTRIBUTE = "urn:opensesame:params:scim:2.0:role";

/** Prior userName/externalId values, so a rename still deprovisions. */
export const SCIM_SUBJECTS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:subjects";

/**
 * Principals already identified for deprovisioning. Written before the
 * multi-row revocation starts so a retry after a partial failure still knows
 * whose sessions to end, without guessing from a now-removed membership.
 */
const SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-principals";
export const SCIM_DEPROVISION_JOURNAL_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-journal";

type DeprovisionTarget = {
  principalId: string;
  incarnation: string;
  completed: boolean;
  legacyOrphan?: {
    authorityRevision: string;
    withdrawalId: string;
  };
};

type DeprovisionJournal = { cycle: string; targets: DeprovisionTarget[] };

export function deprovisionJournal(
  user: ScimUserRecord,
): DeprovisionJournal | undefined {
  const value = user.raw[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const cycle = Reflect.get(value, "cycle");
  const targets = Reflect.get(value, "targets");
  if (typeof cycle !== "string" || !Array.isArray(targets)) return undefined;
  const parsed: DeprovisionTarget[] = [];
  for (const target of targets) {
    if (!target || typeof target !== "object" || Array.isArray(target))
      return undefined;
    const principalId = Reflect.get(target, "principalId");
    const incarnation = Reflect.get(target, "incarnation");
    const completed = Reflect.get(target, "completed");
    if (
      typeof principalId !== "string" ||
      typeof incarnation !== "string" ||
      typeof completed !== "boolean"
    )
      return undefined;
    const legacyOrphan = Reflect.get(target, "legacyOrphan");
    if (legacyOrphan !== undefined) {
      if (
        !legacyOrphan ||
        typeof legacyOrphan !== "object" ||
        Array.isArray(legacyOrphan)
      )
        return undefined;
      const authorityRevision = Reflect.get(legacyOrphan, "authorityRevision");
      const withdrawalId = Reflect.get(legacyOrphan, "withdrawalId");
      if (
        typeof authorityRevision !== "string" ||
        typeof withdrawalId !== "string"
      )
        return undefined;
      parsed.push({
        principalId,
        incarnation,
        completed,
        legacyOrphan: { authorityRevision, withdrawalId },
      });
    } else parsed.push({ principalId, incarnation, completed });
  }
  return { cycle, targets: parsed };
}

/** Directory-supplied payloads cannot set or read internal reconciliation state. */
export const SCIM_BOOKKEEPING_ATTRIBUTES = new Set([
  SCIM_ROLE_ATTRIBUTE,
  SCIM_SUBJECTS_ATTRIBUTE,
  SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE,
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
]);

const ORG_IDENTITY_KINDS = ["oidc", "oauth2", "saml", "ldap", "email"] as const;

export function roleOf(user: ScimUserRecord): OrganizationRole | undefined {
  const stored = user.raw[SCIM_ROLE_ATTRIBUTE];
  return stored === "owner" || stored === "admin" || stored === "member"
    ? stored
    : undefined;
}

export function rememberedSubjects(...users: ScimUserRecord[]): string[] {
  const subjects = new Set<string>();
  for (const user of users) {
    if (user.externalId) subjects.add(user.externalId);
    if (user.userName) subjects.add(user.userName);
    const extra = user.raw[SCIM_SUBJECTS_ATTRIBUTE];
    if (!Array.isArray(extra)) continue;
    for (const value of extra) {
      if (isString(value) && value) subjects.add(value);
    }
  }
  return [...subjects];
}

export function withRememberedSubjects(
  previous: ScimUserRecord,
  next: ScimUserRecord,
): ScimUserRecord {
  return {
    ...next,
    raw: {
      ...next.raw,
      [SCIM_SUBJECTS_ATTRIBUTE]: rememberedSubjects(previous, next),
    },
  };
}

/**
 * The role a directory-provisioned subject should join at, or `undefined`
 * when no mapped Groups push has said otherwise.
 */
export async function provisionedRoleForSubject(
  ctx: AppContext,
  organizationId: string,
  subject: string,
): Promise<OrganizationRole | undefined> {
  const user = await ctx.stores.scim.users.findBySubject(
    organizationId,
    subject,
  );
  if (!user?.active) return undefined;
  return roleOf(user);
}

/**
 * The principals of THIS organization a directory subject names.
 *
 * The `(kind, issuer, subject)` tuple is only as tenant-scoped as the issuer,
 * and an organization's issuer is a string its owner typed: it can be a
 * public IdP other tenants' members also sign in with. Whatever the tuple
 * resolves to, SCIM acts only on a principal that holds a membership here —
 * a push from one tenant's directory must never sign out anybody else.
 */
/**
 * Issuers this organization actually admits people under.
 *
 * SSO and SAML issuer strings are not the whole set. LDAP sign-in stores
 * `ldapIssuer` of the directory URL, and native SAML with no `samlIssuer`
 * stores the metadata entityID. Both have to be searched or deprovision
 * reports success while the membership stays.
 *
 * Imports are dynamic: the LDAP and SAML modules call back into organization
 * routes, which load this file.
 */
async function issuersForOrganization(
  ctx: AppContext,
  organization: Organization,
): Promise<string[]> {
  const issuers = [organization.ssoIssuer, organization.samlIssuer].filter(
    (issuer): issuer is string => isString(issuer) && issuer.length > 0,
  );
  const ldap = await ctx.stores.orgFederation.ldapConfigs.get(organization.id);
  if (ldap) {
    try {
      const { ldapIssuer } = await import("../interactions/ldap.js");
      const directoryIssuer = ldapIssuer(ldap);
      if (!issuers.includes(directoryIssuer)) issuers.push(directoryIssuer);
    } catch {
      /* An unusable directory URL is not an issuer. */
    }
  }
  if (
    !organization.samlIssuer &&
    (organization.samlMetadataUrl || organization.samlMetadataXml)
  ) {
    try {
      const { resolveIdpMetadata, samlOrgConfig } = await import(
        "../interactions/saml.js"
      );
      const cfg = samlOrgConfig(organization);
      if (cfg) {
        const entityId = (await resolveIdpMetadata(ctx, cfg)).entityId;
        if (entityId && !issuers.includes(entityId)) issuers.push(entityId);
      }
    } catch {
      /* Metadata that cannot be read adds no issuer. */
    }
  }
  return issuers;
}

async function principalsForSubject(
  ctx: AppContext,
  organization: Organization,
  subject: string,
  requireMembership = true,
): Promise<string[]> {
  const issuers = await issuersForOrganization(ctx, organization);
  const principalIds = new Set<string>();
  for (const issuer of issuers) {
    for (const kind of ORG_IDENTITY_KINDS) {
      for (const tenant of [organization.id, undefined]) {
        const identity = await ctx.repos.externalIdentities.findByTuple({
          kind,
          issuer,
          ...(tenant !== undefined ? { tenant } : undefined),
          subject,
        });
        if (identity) principalIds.add(identity.principalId);
      }
    }
  }
  if (!requireMembership) return [...principalIds];
  const members: string[] = [];
  for (const principalId of principalIds) {
    const membership = await ctx.stores.organizationMemberships.find(
      organization.id,
      principalId,
    );
    if (membership) members.push(principalId);
  }
  return members;
}

async function principalsForUser(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  requireMembership = true,
): Promise<string[]> {
  const principalIds = new Set<string>();
  for (const subject of rememberedSubjects(user)) {
    for (const id of await principalsForSubject(
      ctx,
      organization,
      subject,
      requireMembership,
    )) {
      principalIds.add(id);
    }
  }
  return [...principalIds];
}

/** Withdraw a deactivated subject's membership and live sessions (D11). */
export async function deprovision(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  correlationId: string,
  _previous?: ScimUserRecord,
): Promise<void> {
  const journal = deprovisionJournal(user);
  if (!journal)
    throw new Error(
      "Cannot safely resume a legacy SCIM deactivation without an incarnation journal",
    );
  for (const target of journal.targets) {
    if (target.completed) continue;
    if (target.legacyOrphan) {
      const { revokeOrganizationMembership } = await import(
        "./organization-revocation.js"
      );
      await revokeOrganizationMembership(ctx, {
        organizationId: organization.id,
        principalId: target.principalId,
        correlationId,
        reason: "scim_deactivated",
        revokeSessionsWithoutMembership: true,
      });
      const { hostApiEndpoint } = await import("../services/host-endpoint.js");
      const url = hostApiEndpoint(
        ctx.config.hostApiUrl,
        "api/v1/sessions/revoke",
      );
      if (!url) throw new Error("Host session revocation is unavailable");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opensesame-operator": ctx.config.operatorToken,
        },
        body: JSON.stringify({
          organization_id: organization.id,
          principal_id: target.principalId,
          membership_incarnation: target.incarnation,
          authority_revision: target.legacyOrphan.authorityRevision,
          withdrawal_id: target.legacyOrphan.withdrawalId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error("Host session revocation is unavailable");
    } else {
      await removeDirectoryMembership(ctx, {
        organizationId: organization.id,
        principalId: target.principalId,
        incarnation: target.incarnation,
        correlationId,
        reason: "scim_deactivated",
      });
    }
    await withScimOrganizationBoundary(ctx, organization.id, async (tx) => {
      const current = await tx.stores.scim.users.getVersioned(
        organization.id,
        user.id,
      );
      if (!current) return;
      const latest = deprovisionJournal(current.user);
      if (!latest || latest.cycle !== journal.cycle) return;
      const next = {
        ...current.user,
        raw: {
          ...current.user.raw,
          [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: {
            ...latest,
            targets: latest.targets.map((entry) =>
              entry.principalId === target.principalId &&
              entry.incarnation === target.incarnation
                ? { ...entry, completed: true }
                : entry,
            ),
          },
        },
      };
      await tx.stores.scim.users.replaceIfRevision(
        organization.id,
        user.id,
        current.revision,
        next,
      );
    });
  }
}

/** Persist exact membership incarnations before an inactive SCIM row commits. */
export async function prepareDeprovision(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  correlationId: string,
): Promise<ScimUserRecord> {
  const targets: DeprovisionTarget[] = [];
  const resolved = await principalsForUser(ctx, organization, user, false);
  const legacy = user.raw[SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE];
  const legacyPrincipals = Array.isArray(legacy)
    ? legacy.filter(
        (value): value is string => isString(value) && value.length > 0,
      )
    : [];
  for (const principalId of new Set([...resolved, ...legacyPrincipals])) {
    const membership = await ctx.stores.organizationMemberships.findVersioned(
      organization.id,
      principalId,
    );
    if (!membership) {
      if (legacyPrincipals.includes(principalId))
        targets.push({
          principalId,
          incarnation: randomUUID(),
          completed: false,
          legacyOrphan: {
            authorityRevision: randomUUID(),
            withdrawalId: randomUUID(),
          },
        });
      continue;
    }
    const prepared = await prepareDirectoryRemoval(ctx, {
      organizationId: organization.id,
      principalId,
      incarnation: membership.incarnation,
      correlationId,
      reason: "scim_deactivated",
    });
    if (prepared.status !== "ready" && prepared.status !== "missing")
      throw new Error("Directory removal could not be prepared");
    if (prepared.status === "ready")
      targets.push({
        principalId,
        incarnation: membership.incarnation,
        completed: false,
      });
  }
  return {
    ...user,
    raw: {
      ...user.raw,
      [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: { cycle: randomUUID(), targets },
    },
  };
}

/** Apply a Groups mapping to whoever already holds a membership here. */
export async function applyRole(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  role: OrganizationRole,
): Promise<void> {
  for (const principalId of await principalsForUser(ctx, organization, user)) {
    await serializeMembershipMutation(ctx, organization.id, async () => {
      const existing = await ctx.stores.organizationMemberships.find(
        organization.id,
        principalId,
      );
      if (!existing || existing.role === role) return;
      await ctx.stores.organizationMemberships.upsert({
        ...existing,
        role,
        updatedAt: ctx.clock(),
      });
    });
  }
}
