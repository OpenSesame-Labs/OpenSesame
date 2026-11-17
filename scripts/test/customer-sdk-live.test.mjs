import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

test("the SDK live check withdraws every possibly accepted approval after setup fails", async (t) => {
  const approvals = [];
  const withdrawals = [];
  let authorizations = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/device/authorize") {
      authorizations += 1;
      response.end(
        JSON.stringify({
          user_code: "BCDF-GHJK",
          device_code: `dc_${authorizations}`,
        }),
      );
    } else if (request.url === "/api/v1/device/approve") {
      approvals.push(body);
      response.statusCode = approvals.length === 2 ? 503 : 200;
      response.end("{}");
    } else if (request.url === "/api/v1/device/token") {
      response.end(JSON.stringify({ access_token: "synthetic-token" }));
    } else if (request.url === "/api/v1/sessions/revoke") {
      withdrawals.push(body);
      response.statusCode = withdrawals.length === 1 ? 503 : 200;
      response.end("{}");
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/test/customer-sdk-live.mts"],
    {
      env: {
        ...process.env,
        OPENSESAME_TEST_HOST_URL: `http://127.0.0.1:${address.port}`,
        OPENSESAME_OPERATOR_TOKEN: "synthetic-operator-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errorOutput = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    errorOutput += chunk;
  });
  child.stdout.resume();
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(errorOutput, /Customer SDK regression failed/);
  assert.equal(approvals.length, 2);
  assert.equal(
    withdrawals.length,
    2,
    "a failed withdrawal must not suppress the others",
  );
  for (const approval of approvals) {
    const withdrawal = withdrawals.find(
      (value) => value.organization_id === approval.organization_id,
    );
    assert(withdrawal);
    assert.equal(withdrawal.principal_id, approval.principal);
    assert.equal(
      withdrawal.membership_incarnation,
      approval.membership_incarnation,
    );
    assert.equal(withdrawal.authority_revision, approval.authority_revision);
    assert.match(withdrawal.withdrawal_id, /^[0-9a-f-]{36}$/);
  }
});
