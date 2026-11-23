import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { identityFetch } from "./identity.js";

export type DeviceApprovalOrganization = { id: string; name: string };
export const NO_ACTIVE_DEVICE_ORGANIZATION =
  "No active organization is available for device approval.";

async function listOrganizations(): Promise<DeviceApprovalOrganization[]> {
  const response = await identityFetch("/v1/organizations", { method: "GET" });
  if (!response.ok) throw new Error("Could not load organizations.");
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body) || !Array.isArray(body.organizations)) {
    throw new Error("Could not load organizations.");
  }
  const rows: DeviceApprovalOrganization[] = [];
  for (const value of body.organizations) {
    if (
      !isJsonObject(value) ||
      !isString(value.id) ||
      !value.id ||
      !isString(value.state)
    ) {
      throw new Error("Could not load organizations.");
    }
    if (value.state !== "active") continue;
    const name =
      isString(value.displayName) && value.displayName.trim()
        ? value.displayName
        : isString(value.slug) && value.slug.trim()
          ? value.slug
          : value.id;
    rows.push({ id: value.id, name });
  }
  if (body.organizations.length > 0 && rows.length === 0) {
    throw new Error(NO_ACTIVE_DEVICE_ORGANIZATION);
  }
  return rows;
}

export const deviceApprovalOrganizationSeams = { listOrganizations };
