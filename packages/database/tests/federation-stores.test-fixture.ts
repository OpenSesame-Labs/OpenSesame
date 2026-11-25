import type { OrgFederationStores } from "../src/org-federation-store.js";
import {
  createMemoryOrgFederationStores,
  createPostgresOrgFederationStores,
} from "../src/org-federation-store.js";
import type {
  OrganizationStores,
  Repositories,
} from "../src/repos/interfaces.js";
import {
  MemoryRepositories,
  createMemoryOrganizationStores,
} from "../src/repos/memory.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import {
  type SamlStores,
  createMemorySamlStores,
  createPostgresSamlStores,
} from "../src/saml-store.js";
import {
  type ScimStores,
  createMemoryScimStores,
  createPostgresScimStores,
} from "../src/scim-store.js";
import type { createPgOwner } from "./pg-harness-full.js";

export interface FederationBackend {
  repos: Repositories;
  organizations: OrganizationStores;
  saml: SamlStores;
  scim: ScimStores;
  federation: OrgFederationStores;
}

async function memoryBackend(): Promise<FederationBackend> {
  return {
    repos: new MemoryRepositories(),
    organizations: createMemoryOrganizationStores(),
    saml: createMemorySamlStores(),
    scim: createMemoryScimStores(),
    federation: createMemoryOrgFederationStores(),
  };
}

async function postgresBackend(
  owner: ReturnType<typeof createPgOwner>,
): Promise<FederationBackend> {
  const ctx = await owner.acquire();
  return {
    repos: ctx.repos,
    organizations: createPostgresOrganizationStores(ctx.db),
    saml: createPostgresSamlStores(ctx.db),
    scim: createPostgresScimStores(ctx.db),
    federation: createPostgresOrgFederationStores(ctx.db),
  };
}

export const federationBackends = [
  {
    name: "memory",
    create: (_owner: ReturnType<typeof createPgOwner>) => memoryBackend(),
  },
  { name: "postgres", create: postgresBackend },
] as const;
