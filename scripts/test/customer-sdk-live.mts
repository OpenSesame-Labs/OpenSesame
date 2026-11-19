/** Live public SDK regression; supply a loopback Host fixture and its synthetic operator token. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApiClient } from "../../packages/api-client/src/index.js";
import { isJsonObject, isString } from "../../packages/os-domain/src/index.js";

const base = process.env.OPENSESAME_TEST_HOST_URL;
const operator = process.env.OPENSESAME_OPERATOR_TOKEN;
assert(
  base && operator,
  "live Host URL and synthetic operator credential required",
);
assert.equal(
  new URL(base).hostname,
  "127.0.0.1",
  "test requires a loopback fixture",
);
const principal = `principal:${randomUUID()}`;
const organizations = [`org:${randomUUID()}`, `org:${randomUUID()}`];
const clientId = "opensesame-cli";
const approvals: Array<{
  principal_id: string;
  organization_id: string;
  membership_incarnation: string;
  authority_revision: string;
  withdrawal_id: string;
}> = [];

type HostRequest =
  | { client_id: string }
  | {
      user_code: string;
      principal: string;
      organization_id: string;
      organization_role: string;
      membership_incarnation: string;
      authority_revision: string;
    }
  | { client_id: string; device_code: string; grant_type: string }
  | (typeof approvals)[number];

async function post(path: string, body: HostRequest, authorized = false) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) headers.set("x-opensesame-operator", operator ?? "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `public ${path} failed`);
  const value = await response.json();
  assert(isJsonObject(value), "invalid public JSON response");
  return value;
}

async function session(organization: string, subject = principal) {
  const authorization = await post("/api/v1/device/authorize", {
    client_id: clientId,
  });
  assert(
    isString(authorization.user_code) && isString(authorization.device_code),
  );
  const revision = {
    membership_incarnation: randomUUID(),
    authority_revision: randomUUID(),
  };
  // Record the cleanup identity before sending the approval: a lost response
  // may still mean that the Host accepted the request.
  approvals.push({
    principal_id: subject,
    organization_id: organization,
    ...revision,
    withdrawal_id: randomUUID(),
  });
  await post(
    "/api/v1/device/approve",
    {
      user_code: authorization.user_code,
      principal: subject,
      organization_id: organization,
      organization_role: "owner",
      ...revision,
    },
    true,
  );
  const token = await post("/api/v1/device/token", {
    client_id: clientId,
    device_code: authorization.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert(isString(token.access_token));
  return createApiClient({
    baseUrl: base ?? "",
    accessToken: token.access_token,
  });
}

let failure: unknown;
try {
  const firstOrganization = organizations[0];
  const secondOrganization = organizations[1];
  assert(firstOrganization && secondOrganization);
  const customerA = await session(firstOrganization);
  const customerB = await session(secondOrganization);
  const blobA = `customer-a-${randomUUID()}`;
  const blobB = blobA;
  const outsiderPrincipal = `principal:${randomUUID()}`;
  const outsider = await session(firstOrganization, outsiderPrincipal);
  const ciphertextA = randomBytes(48).toString("base64");
  const ciphertextB = randomBytes(48).toString("base64");
  const ownA = await customerA.syncPush([
    { id: blobA, epoch: 1, ciphertextB64: ciphertextA },
  ]);
  assert(isJsonObject(ownA));
  assert.equal(ownA.accepted, 1);
  const independent = await customerB.syncPush([
    { id: blobB, epoch: 2, ciphertextB64: ciphertextB },
  ]);
  assert(isJsonObject(independent));
  assert.equal(independent.accepted, 1);
  const foreign = await outsider.syncPush([
    { id: blobA, epoch: 3, ciphertextB64: ciphertextB },
  ]);
  assert(isJsonObject(foreign));
  assert.equal(foreign.accepted, 0);
  assert.equal(foreign.rejected_foreign_owner, 1);
  const pageA = await customerA.syncReadPage(
    { epoch: 1, id: "" },
    "customer-a-device",
  );
  const pageB = await customerB.syncReadPage(
    { epoch: 1, id: "" },
    "customer-b-device",
  );
  assert.deepEqual(
    pageA.blobs.map((blob) => blob.id),
    [blobA],
  );
  assert.deepEqual(
    pageB.blobs.map((blob) => blob.id),
    [blobB],
  );
  assert.equal(pageA.blobs[0]?.ciphertext_b64, ciphertextA);
  assert.equal(pageB.blobs[0]?.ciphertext_b64, ciphertextB);
  const spoofedDevice = await customerA.syncReadPage(
    { epoch: 1, id: "" },
    "customer-b-device",
  );
  assert.deepEqual(
    spoofedDevice.blobs.map((blob) => blob.id),
    [blobA],
  );
  console.log(
    "PASS: real Host public device approval + API SDK sync; same principal and same blob ID, two customer organizations; outsider overwrite refused; pages and device filters remain customer-scoped.",
  );
} catch (error) {
  failure = error;
}
const cleanup = await Promise.allSettled(
  approvals.map((approval) => post("/api/v1/sessions/revoke", approval, true)),
);
const errors = cleanup.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : [],
);
if (failure !== undefined) errors.unshift(failure);
if (errors.length)
  throw new AggregateError(errors, "Customer SDK regression failed");
