import { randomUUID } from "node:crypto";
import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  type ScimUserRecord,
} from "@opensesame/database";
import type { Organization, OrganizationRole } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  type PreparedWithdrawal,
  finishOrganizationWithdrawal,
  prepareRoleWithdrawal,
} from "../services/organization-withdrawal.js";
import {
  prepareDirectoryRemoval,
  removeDirectoryMembership,
} from "./directory-removal.js";
import { finishLegacyOrphan } from "./scim-legacy-orphan.js";

export const SCIM_ROLE_ATTRIBUTE = "urn:opensesame:params:scim:2.0:role";

export const SCIM_SUBJECTS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:subjects";

const SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-principals";

export { SCIM_DEPROVISION_JOURNAL_ATTRIBUTE };

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

function deprovisionTarget(value: unknown): DeprovisionTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const principalId = Reflect.get(value, "principalId");
  const incarnation = Reflect.get(value, "incarnation");
  const completed = Reflect.get(value, "completed");
  if (
    typeof principalId !== "string" ||
    typeof incarnation !== "string" ||
    typeof completed !== "boolean"
  )
    return;
  const legacy = Reflect.get(value, "legacyOrphan");
  if (legacy === undefined) return { principalId, incarnation, completed };
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return;
  const authorityRevision = Reflect.get(legacy, "authorityRevision");
  const withdrawalId = Reflect.get(legacy, "withdrawalId");
  if (typeof authorityRevision !== "string" || typeof withdrawalId !== "string")
    return;
  return {
    principalId,
    incarnation,
    completed,
    legacyOrphan: { authorityRevision, withdrawalId },
  };
}

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
    const value = deprovisionTarget(target);
    if (!value) return undefined;
    parsed.push(value);
  }
  return { cycle, targets: parsed };
}

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

/** Issuers this organization actually admits people under. */
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
  organization: Pick<Organization, "id">,
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
      await finishLegacyOrphan(
        ctx,
        organization.id,
        {
          principalId: target.principalId,
          incarnation: target.incarnation,
          ...target.legacyOrphan,
        },
        correlationId,
      );
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

/** Prepare every membership role transition inside the caller's org transaction. */
export async function prepareRoleWithdrawals(
  tx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  role: OrganizationRole,
  correlationId: string,
): Promise<PreparedWithdrawal[]> {
  const pending: PreparedWithdrawal[] = [];
  for (const principalId of await principalsForUser(tx, organization, user)) {
    const prepared = await prepareRoleWithdrawal(tx, {
      organizationId: organization.id,
      principalId,
      role,
      actorPrincipalId: tx.systemOwnerPrincipalId,
      actorType: "system",
      correlationId,
    });
    if (prepared.status === "missing" || prepared.status === "unchanged")
      continue;
    if (prepared.status !== "ready")
      throw new Error("Directory role withdrawal could not be prepared");
    pending.push(prepared.prepared);
  }
  return pending;
}

export async function finishRoleWithdrawals(
  ctx: AppContext,
  pending: PreparedWithdrawal[],
): Promise<void> {
  for (const prepared of pending) {
    const finished = await finishOrganizationWithdrawal(ctx, prepared);
    if (finished.status !== "changed")
      throw new Error(
        "Directory role withdrawal is pending; retry the request",
      );
  }
}
