import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import type { Awaitable } from "./interfaces.js";
import { normalizeIssuer } from "./issuer-normalization.js";

/**
 * Durable organization rows. Tenant SSO/SAML config lives on this row and is
 * read on the login path, so it cannot stay in process memory: a restart that
 * forgets an org's issuer silently turns enterprise sign-in off.
 *
 * `set` keeps the Map upsert semantics the control-plane routes were written
 * against — the caller owns the full row and the store persists it verbatim.
 */
export interface OrganizationStore {
  get(id: string): Awaitable<Organization | undefined>;
  /** Full-row upsert (Map `set` semantics). */
  set(id: string, organization: Organization): Awaitable<void>;
  getBySlug(slug: string): Awaitable<Organization | undefined>;
  /**
   * The org whose `ssoIssuer` OR `samlIssuer` is this issuer, compared
   * trailing-slash-normalized (the stored spelling is left as the operator
   * typed it). Undefined when no org claims it.
   */
  findByIssuer(issuer: string): Awaitable<Organization | undefined>;
  listByCreator(principalId: string): Awaitable<Organization[]>;
}

/** Durable organization membership rows keyed by (organizationId, principalId). */
export interface OrganizationMembershipStore {
  find(
    organizationId: string,
    principalId: string,
  ): Awaitable<OrganizationMembership | undefined>;
  /** Read the row and its internal incarnation in one operation. */
  findVersioned(
    organizationId: string,
    principalId: string,
  ): Awaitable<VersionedOrganizationMembership | undefined>;
  upsert(membership: OrganizationMembership): Awaitable<OrganizationMembership>;
  remove(organizationId: string, principalId: string): Awaitable<boolean>;
  /** Remove only the row observed by a previous versioned read. */
  removeIfIncarnation(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId?: string,
  ): Awaitable<boolean>;
  /** Begin withdrawing this exact incarnation, if no withdrawal is in progress. */
  beginWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    authorityRevision: string,
    withdrawal: OrganizationMembershipWithdrawal,
  ): Awaitable<boolean>;
  /** Clear only the withdrawal acquired for this exact incarnation. */
  clearWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId: string,
  ): Awaitable<boolean>;
  /** Complete the pending role change and rotate the authority revision. */
  completeRoleWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId: string,
    role: OrganizationRole,
    updatedAt: Date,
  ): Awaitable<VersionedOrganizationMembership | undefined>;
  /** Escalate a pending role change to a directory removal without dropping its fence. */
  upgradeRoleWithdrawalToRemoval(
    organizationId: string,
    principalId: string,
    incarnation: string,
    authorityRevision: string,
    previousWithdrawalId: string,
    withdrawal: OrganizationMembershipWithdrawal,
  ): Awaitable<boolean>;
  /** Durable pending intents for restart recovery. */
  listPendingWithdrawals(): Awaitable<
    PendingOrganizationMembershipWithdrawal[]
  >;
  /** Block session use while any membership withdrawal for this principal is pending. */
  hasPendingWithdrawalForPrincipal(principalId: string): Awaitable<boolean>;
  listByOrganization(
    organizationId: string,
  ): Awaitable<OrganizationMembership[]>;
  /** Snapshot each membership and its incarnation in the same read. */
  listVersionedByOrganization(
    organizationId: string,
  ): Awaitable<VersionedOrganizationMembership[]>;
  listByPrincipal(principalId: string): Awaitable<OrganizationMembership[]>;
  /** Owner count — the fence against demoting or removing the last owner. */
  countOwners(organizationId: string): Awaitable<number>;
}

/** Internal concurrency metadata; never included in a membership response. */
export interface VersionedOrganizationMembership {
  membership: OrganizationMembership;
  incarnation: string;
  authorityRevision: string;
  withdrawalId?: string;
  withdrawal?: OrganizationMembershipWithdrawal;
}

export type OrganizationMembershipWithdrawal = {
  id: string;
  actorType: "human" | "system";
  actorPrincipalId: string;
  correlationId: string;
} & (
  | {
      kind: "remove";
      role?: never;
      reason?: OrganizationMembershipWithdrawalReason;
    }
  | { kind: "change_role"; role: OrganizationRole; reason?: never }
);

export type OrganizationMembershipWithdrawalReason =
  | "organization_owner_removed"
  | "scim_deactivated"
  | "ldap_directory_sync";

export type PendingOrganizationMembershipWithdrawal =
  VersionedOrganizationMembership & {
    withdrawalId: string;
    withdrawal: OrganizationMembershipWithdrawal;
  };

/** The pair travels together, as projects do. */
export interface OrganizationStores {
  organizations: OrganizationStore;
  organizationMemberships: OrganizationMembershipStore;
}

/**
 * Row shape both organization stores agree on.
 *
 * Optional fields are present only when set — a Postgres NULL reads back as an
 * absent key, so the memory store must drop empty values too or a round-trip
 * that passes in memory fails against the database (and vice versa).
 */
export function normalizeOrganizationRow(
  organization: Organization,
): Organization {
  const row: Organization = {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    state: organization.state,
    createdBy: organization.createdBy,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
  if (organization.ssoIssuer) row.ssoIssuer = organization.ssoIssuer;
  if (organization.ssoClientId) row.ssoClientId = organization.ssoClientId;
  if (organization.ssoClientSecret) {
    row.ssoClientSecret = organization.ssoClientSecret;
  }
  if (organization.samlIssuer) row.samlIssuer = organization.samlIssuer;
  if (organization.samlMetadataUrl) {
    row.samlMetadataUrl = organization.samlMetadataUrl;
  }
  if (organization.samlMetadataXml) {
    row.samlMetadataXml = organization.samlMetadataXml;
  }
  if (organization.provisioningEnabled) row.provisioningEnabled = true;
  return row;
}

/** True when either issuer column of `organization` names `issuer`. */
export function organizationClaimsIssuer(
  organization: Organization,
  issuer: string,
): boolean {
  const target = normalizeIssuer(issuer);
  if (!target) return false;
  return (
    (organization.ssoIssuer !== undefined &&
      normalizeIssuer(organization.ssoIssuer) === target) ||
    (organization.samlIssuer !== undefined &&
      normalizeIssuer(organization.samlIssuer) === target)
  );
}
