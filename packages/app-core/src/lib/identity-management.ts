import {
  AgentResponseSchema,
  RegisterAgentResponseSchema,
} from "@opensesame/contracts";
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { call } from "./directory.js";

export type DirectoryUser = {
  id: string;
  userName: string;
  displayName: string;
  active: boolean;
};
export function directoryUser(value: BoundaryValue): DirectoryUser {
  if (
    !isJsonObject(value) ||
    !isString(value.id) ||
    !isString(value.userName) ||
    !isBoolean(value.active)
  ) {
    throw new Error("Identity returned an invalid directory user.");
  }
  return {
    id: value.id,
    userName: value.userName,
    displayName: isString(value.displayName) ? value.displayName : "",
    active: value.active,
  };
}

function usersPath(organization: string) {
  return `/v1/organizations/${encodeURIComponent(organization)}/scim/v2/Users`;
}

const DIRECTORY_PAGE_SIZE = 200;
const DIRECTORY_USER_LIMIT = 10_000;

type DirectoryPage = {
  resources: DirectoryUser[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
};

function directoryPage(value: BoundaryValue): DirectoryPage {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.Resources) ||
    !isNumber(value.totalResults) ||
    !Number.isSafeInteger(value.totalResults) ||
    value.totalResults < 0 ||
    !isNumber(value.startIndex) ||
    !Number.isSafeInteger(value.startIndex) ||
    value.startIndex < 1 ||
    !isNumber(value.itemsPerPage) ||
    !Number.isSafeInteger(value.itemsPerPage) ||
    value.itemsPerPage < 0 ||
    value.itemsPerPage > DIRECTORY_PAGE_SIZE
  ) {
    throw new Error("Identity returned an invalid directory page.");
  }
  const resources = value.Resources.map(directoryUser);
  if (resources.length !== value.itemsPerPage)
    throw new Error("Identity returned an inconsistent directory page.");
  return {
    resources,
    totalResults: value.totalResults,
    startIndex: value.startIndex,
    itemsPerPage: value.itemsPerPage,
  };
}

export async function listDirectoryUsers(
  organization: string,
): Promise<DirectoryUser[]> {
  const path = usersPath(organization);
  const users: DirectoryUser[] = [];
  let startIndex = 1;
  for (;;) {
    const page = await call(
      `${path}?startIndex=${startIndex}&count=${DIRECTORY_PAGE_SIZE}`,
      {},
      directoryPage,
    );
    if (
      page.startIndex !== startIndex ||
      page.totalResults > DIRECTORY_USER_LIMIT ||
      users.length + page.resources.length > page.totalResults
    ) {
      throw new Error("Identity returned an invalid directory page.");
    }
    users.push(...page.resources);
    if (users.length >= page.totalResults) return users;
    if (page.itemsPerPage === 0)
      throw new Error("Identity returned an incomplete directory.");
    startIndex += page.itemsPerPage;
  }
}
export function createDirectoryUser(
  organization: string,
  userName: string,
  displayName: string,
) {
  return call(
    usersPath(organization),
    {
      method: "POST",
      body: JSON.stringify({ userName, displayName, active: true }),
    },
    directoryUser,
  );
}
export function updateDirectoryUser(organization: string, user: DirectoryUser) {
  return call(
    `${usersPath(organization)}/${encodeURIComponent(user.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        Operations: [
          {
            op: "replace",
            value: {
              userName: user.userName,
              displayName: user.displayName,
              active: user.active,
            },
          },
        ],
      }),
    },
    directoryUser,
  );
}

export function listManagedAgents() {
  return call("/v1/agents", {}, (body) => {
    if (!isJsonObject(body) || !Array.isArray(body.agents))
      throw new Error("Identity returned an invalid agent directory.");
    return body.agents.map((agent) => AgentResponseSchema.parse(agent));
  });
}
export function registerManagedAgent(
  displayName: string,
  publicKeyJkt: string,
) {
  return call(
    "/v1/agents",
    {
      method: "POST",
      body: JSON.stringify({ displayName, publicKeyJkt }),
    },
    (body) => {
      const registration = RegisterAgentResponseSchema.parse(body);
      // The UI needs the registration ID, not the claim bearer returned to agent runtimes.
      return { id: registration.agentId };
    },
  );
}
export function updateManagedAgent(
  id: string,
  patch: { displayName?: string; state?: "revoked" },
) {
  return call(
    `/v1/agents/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
    (body) => AgentResponseSchema.parse(body),
  );
}
