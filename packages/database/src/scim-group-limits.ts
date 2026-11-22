import type { OrganizationRole } from "@opensesame/os-domain";

export const SCIM_GROUPS_PER_ORGANIZATION = 2_000;
export const SCIM_GROUPS_PER_DEPLOYMENT = 20_000;
export const SCIM_GROUP_MEMBERS_MAX = 1_000;
export const SCIM_GROUP_CHANGES_MAX = 100;
export const SCIM_GROUP_ID_MAX = 128;

const ROLE_RANK = {
  member: 1,
  admin: 2,
  owner: 3,
} as const satisfies Record<OrganizationRole, number>;

/**
 * The id ceiling bounds new admissions only. A record that predates it may
 * still be reduced: an over-long group id can keep an existing mapping at the
 * same or a lower role, so its privileges can always be withdrawn.
 */
export function scimMappingAdmissible(
  groupId: string,
  role: OrganizationRole,
  existing: OrganizationRole | undefined,
): boolean {
  if (!groupId) return false;
  if (groupId.length <= SCIM_GROUP_ID_MAX) return true;
  return existing !== undefined && ROLE_RANK[role] <= ROLE_RANK[existing];
}

export interface ScimGroupLimits {
  perOrganization: number;
  perDeployment: number;
}

export class ScimGroupCapacityError extends Error {
  override readonly name = "ScimGroupCapacityError";
  constructor() {
    super("SCIM group capacity reached");
  }
}

export class ScimGroupPayloadError extends Error {
  override readonly name = "ScimGroupPayloadError";
  constructor() {
    super("SCIM group exceeds the storage limit");
  }
}

export function scimGroupLimits(
  limits?: Partial<ScimGroupLimits>,
): ScimGroupLimits {
  const perOrganization =
    limits?.perOrganization ?? SCIM_GROUPS_PER_ORGANIZATION;
  const perDeployment = limits?.perDeployment ?? SCIM_GROUPS_PER_DEPLOYMENT;
  if (
    !Number.isSafeInteger(perOrganization) ||
    perOrganization < 1 ||
    perOrganization > SCIM_GROUPS_PER_ORGANIZATION ||
    !Number.isSafeInteger(perDeployment) ||
    perDeployment < 1 ||
    perDeployment > SCIM_GROUPS_PER_DEPLOYMENT
  )
    throw new Error("Invalid SCIM group limits");
  return { perOrganization, perDeployment };
}
