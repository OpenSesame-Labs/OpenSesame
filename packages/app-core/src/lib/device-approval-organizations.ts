import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { identityFetch } from "./identity.js";

export type DeviceApprovalOrganization = { id: string; name: string };
export const NO_ACTIVE_DEVICE_ORGANIZATION =
  "No active organization is available for device approval.";
const UNREADABLE = "Could not load organizations.";

function nonEmpty(value: BoundaryValue | undefined): string | null {
  return isString(value) && value.trim() ? value : null;
}

/** One listed organization: a row when active, null when not, throws when malformed. */
function organizationRow(
  value: BoundaryValue,
): DeviceApprovalOrganization | null {
  if (!isJsonObject(value) || !nonEmpty(value.id) || !isString(value.state))
    throw new Error(UNREADABLE);
  if (value.state !== "active") return null;
  const id = String(value.id);
  return {
    id,
    name: nonEmpty(value.displayName) ?? nonEmpty(value.slug) ?? id,
  };
}

async function listOrganizations(): Promise<DeviceApprovalOrganization[]> {
  const response = await identityFetch("/v1/organizations", { method: "GET" });
  if (!response.ok) throw new Error(UNREADABLE);
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body) || !Array.isArray(body.organizations))
    throw new Error(UNREADABLE);
  const rows = body.organizations
    .map(organizationRow)
    .filter((row): row is DeviceApprovalOrganization => row !== null);
  if (body.organizations.length > 0 && rows.length === 0)
    throw new Error(NO_ACTIVE_DEVICE_ORGANIZATION);
  return rows;
}

export const deviceApprovalOrganizationSeams = { listOrganizations };
