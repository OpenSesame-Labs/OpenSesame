import { readFileSync } from "node:fs";
import { safeLoad } from "js-yaml";
import { describe, expect, it } from "vitest";

const hostOpenApi = readFileSync(
  new URL("../../../../spec/openapi/host-api.yaml", import.meta.url),
  "utf8",
);

type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  type?: string | string[];
  format?: string;
  pattern?: string;
  $ref?: string;
  items?: Schema;
  const?: unknown;
};
// SAFETY: The repository fixture's accessed schema properties are asserted below.
const spec = safeLoad(hostOpenApi) as {
  components: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    {
      post?: {
        responses: Record<string, { description?: string; $ref?: string }>;
        requestBody?: { content: { "application/json": { schema: Schema } } };
      };
    }
  >;
};

describe("Host organization authority OpenAPI", () => {
  it("documents organization-bound session and revocation claims", () => {
    for (const fragment of [
      "  /device/approve:",
      "  /sessions/revoke:",
      "security: [{ HostOperatorBearer: [] }, { HostOperatorHeader: [] }]",
      "organization_id: { type: string }",
      'organization_role: { $ref: "#/components/schemas/OrganizationRole" }',
      'session: { $ref: "#/components/schemas/HostSession" }',
      'project_id: { type: [string, "null"] }',
      'credential_handle: { type: [string, "null"] }',
      'membership_incarnation: { type: [string, "null"], format: uuid }',
      'authority_revision: { type: [string, "null"], format: uuid }',
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
  });

  it("documents the exact authority needed to withdraw a membership revision", () => {
    const request = spec.components.schemas.RevokeSessionsRequest;
    expect(request?.required).toEqual([
      "principal_id",
      "organization_id",
      "membership_incarnation",
      "authority_revision",
      "withdrawal_id",
    ]);
    for (const field of [
      "membership_incarnation",
      "authority_revision",
      "withdrawal_id",
    ]) {
      expect(request?.properties?.[field]?.$ref).toBe(
        "#/components/schemas/NonNilUuid",
      );
    }
    const canonical = spec.components.schemas.NonNilUuid;
    expect(canonical).toMatchObject({ type: "string", format: "uuid" });
    const validRevision = new RegExp(canonical?.pattern ?? "^");
    expect(validRevision.test("2e70e15b-dba0-44d8-8b15-fc565b62ba68")).toBe(
      true,
    );
    expect(validRevision.test("00000000-0000-0000-0000-000000000000")).toBe(
      false,
    );
    expect(validRevision.test("2E70E15B-DBA0-44D8-8B15-FC565B62BA68")).toBe(
      false,
    );
    expect(spec.paths["/sessions/revoke"]?.post?.responses).toHaveProperty(
      "503",
    );
  });

  it("distinguishes Identity-approved devices from local bootstrap", () => {
    const approval = spec.components.schemas.DeviceApproveRequest;
    expect(approval?.required).toEqual(["user_code", "principal"]);
    const [identity, bootstrap] = approval?.oneOf ?? [];
    expect(identity?.required).toEqual([
      "organization_id",
      "organization_role",
      "membership_incarnation",
      "authority_revision",
    ]);
    for (const field of [
      "organization_id",
      "organization_role",
      "membership_incarnation",
      "authority_revision",
    ]) {
      expect(bootstrap?.properties?.[field]?.type).toBe("null");
    }
  });

  it("documents bound agent launches", () => {
    const launch =
      spec.paths["/agent-launches"]?.post?.requestBody?.content[
        "application/json"
      ].schema;
    const [local, bound] = launch?.oneOf ?? [];
    expect(local?.properties?.membership_incarnation?.type).toBe("null");
    expect(local?.properties?.authority_revision?.type).toBe("null");
    expect(bound?.required).toEqual([
      "membership_incarnation",
      "authority_revision",
    ]);
  });

  it("documents the separate join pairing ceiling", () => {
    const pairing =
      spec.paths["/browser-pairings"]?.post?.requestBody?.content[
        "application/json"
      ].schema;
    expect(pairing?.properties?.capabilities?.oneOf?.[1]?.items?.const).toBe(
      "host.join",
    );
    expect(
      spec.paths["/browser-pairings/decision"]?.post?.responses,
    ).toHaveProperty("503");
  });

  it("describes the session and operator responses actually returned by the Host", () => {
    const session = spec.components.schemas.HostSession;
    expect(session?.required).toEqual(
      expect.arrayContaining([
        "principal_id",
        "organization_id",
        "organization_role",
        "local_session",
        "membership_incarnation",
        "authority_revision",
        "auth_time",
        "issued_at",
        "expires_at",
      ]),
    );
    expect(session?.required).not.toContain("session_id");
    expect(session?.required).not.toContain("issuer");
    expect(session?.properties?.membership_incarnation?.type).toEqual([
      "string",
      "null",
    ]);
    expect(spec.components.schemas.WhoAmI?.oneOf?.[0]?.$ref).toBe(
      "#/components/schemas/HostSession",
    );
    expect(spec.components.schemas.WhoAmI?.oneOf?.[1]?.required).toEqual([
      "authentication",
      "assurance",
      "issuer",
    ]);
  });

  it("states the Host JSON device profile without claiming RFC 8628 wire compatibility", () => {
    expect(hostOpenApi).toContain("OpenSesame Host JSON protocol profile");
    expect(hostOpenApi).not.toContain("summary: Start RFC 8628");
  });

  it("documents organization-fenced tasks and receipt evidence", () => {
    for (const fragment of [
      "  /tasks:",
      "  /tasks/intents:",
      "  /tasks/invoke:",
      "  /receipts/{id}:",
      "  /receipts/{id}/verify:",
      'schema: { $ref: "#/components/schemas/InvocationReceipt" }',
      "Present on schema 3 receipts",
      "Identity `prn_<uuid>`",
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
  });

  it("documents every freeze-intent failure", () => {
    const freezeIntent = hostOpenApi
      .split("  /tasks/intents:")[1]
      ?.split("  /tasks/invoke:")[0];
    for (const status of ['"400"', '"403"', '"404"', '"429"', '"503"']) {
      expect(freezeIntent).toContain(status);
    }
  });

  it("keeps the strict connection schemas aligned with the runtime contract", () => {
    for (const fragment of [
      "            - catalog_unavailable",
      "        provenance_url: { type: string, format: uri }",
      "        catalog_revision: { type: string, minLength: 1 }",
      'items: { $ref: "#/components/schemas/ConfigurationFieldDef" }',
      'items: { $ref: "#/components/schemas/ConfiguredField" }',
      'configuration_set: { $ref: "#/components/schemas/Configuration" }',
      "        configuration_clear:",
      "          minProperties: 1",
      "          minItems: 1",
    ]) {
      expect(hostOpenApi).toContain(fragment);
    }
  });

  it("documents every protected connector operation's operator alternative", () => {
    const operations = [
      ["/providers", "get"],
      ["/integrations", "get"],
      ["/integrations", "post"],
      ["/integrations/{id}", "get"],
      ["/integrations/{id}", "patch"],
      ["/integrations/{id}", "delete"],
      ["/connections", "get"],
      ["/connections", "post"],
      ["/connections/discover", "post"],
      ["/connections/{id}", "get"],
      ["/connections/{id}", "patch"],
      ["/connections/{id}", "delete"],
      ["/connections/{id}/authorize", "post"],
      ["/connections/{id}/refresh", "post"],
      ["/connections/{id}/credential", "post"],
      ["/connections/{id}/bindings", "post"],
      ["/connections/{id}/bindings/{binding_id}", "delete"],
      ["/connections/{id}/events", "get"],
    ] as const;
    for (const [path, method] of operations) {
      const pathStart = hostOpenApi.indexOf(`  ${path}:`);
      const pathEnd = hostOpenApi.indexOf("\n  /", pathStart + 1);
      const pathBlock = hostOpenApi.slice(
        pathStart,
        pathEnd === -1 ? undefined : pathEnd,
      );
      const methodStart = pathBlock.indexOf(`    ${method}:`);
      expect(
        methodStart,
        `${method.toUpperCase()} ${path}`,
      ).toBeGreaterThanOrEqual(0);
      const methodTail = pathBlock.slice(methodStart + 1);
      const nextMethod = methodTail.search(
        /\n {4}(get|post|patch|delete|put):/,
      );
      const methodBlock = pathBlock.slice(
        methodStart,
        nextMethod === -1 ? undefined : methodStart + 1 + nextMethod,
      );
      expect(methodBlock, `${method.toUpperCase()} ${path}`).toContain(
        "security: [{ HostBearer: [] }, { HostOperatorHeader: [] }]",
      );
    }
  });
});
