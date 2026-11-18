export const SCIM_TOKENS_PER_ORGANIZATION = 64;
export const SCIM_TOKENS_PER_DEPLOYMENT = 20_000;
export const SCIM_MAPPINGS_PER_ORGANIZATION = 2_000;
export const SCIM_MAPPINGS_PER_DEPLOYMENT = 20_000;

export interface ScimAdminLimits {
  tokensPerOrganization: number;
  tokensPerDeployment: number;
  mappingsPerOrganization: number;
  mappingsPerDeployment: number;
}

export class ScimAdminCapacityError extends Error {
  override readonly name = "ScimAdminCapacityError";
  constructor() {
    super("SCIM administration capacity reached");
  }
}

/** Smaller limits are useful for smaller deployments and deterministic tests. */
export function scimAdminLimits(
  options?: Partial<ScimAdminLimits>,
): ScimAdminLimits {
  const limits = {
    tokensPerOrganization:
      options?.tokensPerOrganization ?? SCIM_TOKENS_PER_ORGANIZATION,
    tokensPerDeployment:
      options?.tokensPerDeployment ?? SCIM_TOKENS_PER_DEPLOYMENT,
    mappingsPerOrganization:
      options?.mappingsPerOrganization ?? SCIM_MAPPINGS_PER_ORGANIZATION,
    mappingsPerDeployment:
      options?.mappingsPerDeployment ?? SCIM_MAPPINGS_PER_DEPLOYMENT,
  };
  const checks: Array<[number, number]> = [
    [limits.tokensPerOrganization, SCIM_TOKENS_PER_ORGANIZATION],
    [limits.tokensPerDeployment, SCIM_TOKENS_PER_DEPLOYMENT],
    [limits.mappingsPerOrganization, SCIM_MAPPINGS_PER_ORGANIZATION],
    [limits.mappingsPerDeployment, SCIM_MAPPINGS_PER_DEPLOYMENT],
  ];
  for (const [actual, maximum] of checks) {
    if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum)
      throw new Error("Invalid SCIM administration limits");
  }
  return limits;
}
