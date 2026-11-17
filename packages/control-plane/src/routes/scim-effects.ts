import { randomUUID } from "node:crypto";
import type { ScimUserRecord } from "@opensesame/database";
import type { Organization, OrganizationRole } from "@opensesame/os-domain";
import { isJsonObject, isString } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  type PreparedWithdrawal,
  prepareRoleWithdrawal,
} from "../services/organization-withdrawal.js";
import {
  prepareDirectoryRemoval,
  removeDirectoryMembership,
} from "./directory-removal.js";

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
export const SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-principals";

/** Durable identity and progress for one deactivation cycle. */
export const SCIM_DEPROVISION_JOURNAL_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-journal";

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

type DeprovisionTarget = {
  principalId: string;
  incarnation: string;
  completed: boolean;
};
type DeprovisionJournal = { cycle: string; targets: DeprovisionTarget[] };

/** A missing or malformed old journal cannot safely identify a past membership. */
export function deprovisionJournal(
  user: ScimUserRecord,
): DeprovisionJournal | undefined {
  const value = user.raw[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE];
  if (
    !isJsonObject(value) ||
    !isString(value.cycle) ||
    !value.cycle ||
    !Array.isArray(value.targets)
  )
    return undefined;
  const targets: DeprovisionTarget[] = [];
  for (const target of value.targets) {
    if (
      !isJsonObject(target) ||
      !isString(target.principalId) ||
      !target.principalId ||
      !isString(target.incarnation) ||
      !target.incarnation ||
      typeof target.completed !== "boolean"
    )
      return undefined;
    targets.push({
      principalId: target.principalId,
      incarnation: target.incarnation,
      completed: target.completed,
    });
  }
  return { cycle: value.cycle, targets };
}

/** Must run inside the organization boundary before the inactive row commits. */
export async function prepareDeprovision(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  correlationId: string,
): Promise<ScimUserRecord> {
  const targets: DeprovisionTarget[] = [];
  for (const principalId of await principalsForUser(
    ctx,
    organization,
    user,
    false,
  )) {
    const current = await ctx.stores.organizationMemberships.findVersioned(
      organization.id,
      principalId,
    );
    if (!current) continue;
    const prepared = await prepareDirectoryRemoval(ctx, {
      organizationId: organization.id,
      principalId,
      incarnation: current.incarnation,
      reason: "scim_deactivated",
      correlationId,
    });
    // An unrelated removal already fences admission until it completes. A
    // competing role change cannot safely be allowed to clear that fence.
    if (prepared.status === "busy" && current.withdrawal?.kind !== "remove") {
      throw new Error("Membership update is in progress; retry deprovisioning");
    }
    if (prepared.status === "last_owner")
      throw new Error("Directory removal could not be prepared");
    targets.push({
      principalId,
      incarnation: current.incarnation,
      completed: false,
    });
  }
  const raw = { ...user.raw };
  delete raw[SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE];
  raw[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE] = { cycle: randomUUID(), targets };
  return { ...user, raw };
}

/** Resume only the exact membership incarnations selected by this transition. */
export async function deprovision(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  correlationId: string,
): Promise<void> {
  const journal = deprovisionJournal(user);
  if (!journal)
    throw new Error(
      "Cannot safely resume a legacy SCIM deactivation without an incarnation journal",
    );
  for (const target of journal.targets) {
    if (target.completed) continue;
    await removeDirectoryMembership(ctx, {
      organizationId: organization.id,
      principalId: target.principalId,
      correlationId,
      reason: "scim_deactivated",
      incarnation: target.incarnation,
    });
    await withScimOrganizationBoundary(ctx, organization.id, async (tx) => {
      const current = await tx.stores.scim.users.getVersioned(
        organization.id,
        user.id,
      );
      if (!current) return;
      const latest = deprovisionJournal(current.user);
      if (!latest || latest.cycle !== journal.cycle) return;
      const targets = latest.targets.map((entry) =>
        entry.principalId === target.principalId &&
        entry.incarnation === target.incarnation
          ? { ...entry, completed: true }
          : entry,
      );
      const updated = await tx.stores.scim.users.replaceIfRevision(
        organization.id,
        user.id,
        current.revision,
        {
          ...current.user,
          raw: {
            ...current.user.raw,
            [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: {
              cycle: latest.cycle,
              targets,
            },
          },
        },
      );
      if (!updated)
        throw new Error("SCIM deprovision journal changed concurrently");
    });
  }
}

/** Prepare membership role changes in the caller's organization transaction. */
export async function applyRole(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  role: OrganizationRole,
  correlationId: string,
  onlyPending = false,
): Promise<PreparedWithdrawal[]> {
  const prepared: PreparedWithdrawal[] = [];
  for (const principalId of await principalsForUser(ctx, organization, user)) {
    const current = await ctx.stores.organizationMemberships.findVersioned(
      organization.id,
      principalId,
    );
    if (!current) continue;
    if (
      onlyPending &&
      (current.withdrawal?.kind !== "change_role" ||
        current.withdrawal.role !== role)
    )
      continue;
    const result = await prepareRoleWithdrawal(ctx, {
      organizationId: organization.id,
      principalId,
      expectedIncarnation: current.incarnation,
      role,
      actorPrincipalId: ctx.systemOwnerPrincipalId,
      actorType: "system",
      correlationId,
    });
    if (result.status === "ready") prepared.push(result.prepared);
    else if (result.status === "last_owner")
      throw new Error(
        "The directory would leave this organization without an owner",
      );
    else if (result.status === "busy")
      throw new Error(
        "Membership update is in progress; retry the group update",
      );
  }
  return prepared;
}
