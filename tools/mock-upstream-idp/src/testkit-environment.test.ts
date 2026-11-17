import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("isolates test IdP users, credentials, and SAML configuration from the ambient environment", () => {
  const require = createRequire(import.meta.url);
  const entry = new URL("./testkit.ts", import.meta.url).href;
  const serverEntry = new URL("./server.ts", import.meta.url).href;
  const jose = pathToFileURL(require.resolve("jose")).href;
  const script = `
    import assert from "node:assert/strict";
    import { importJWK, jwtVerify } from ${JSON.stringify(jose)};
    import { obtainReferenceOidcGrant, startReferenceIdp } from ${JSON.stringify(entry)};
    import { createMockUpstreamIdp } from ${JSON.stringify(serverEntry)};
    const standalone = await createMockUpstreamIdp();
    assert.equal(standalone.config.clientId, process.env.OPENSESAME_UPSTREAM_CLIENT_ID);
    assert.equal(standalone.config.clientSecret, process.env.OPENSESAME_UPSTREAM_CLIENT_SECRET);
    assert.equal(standalone.config.testUser.email, process.env.OPENSESAME_MOCK_IDP_USER_EMAIL);
    assert.equal(standalone.config.samlAcsUrl, process.env.OPENSESAME_MOCK_IDP_SAML_ACS_URL);
    const first = await startReferenceIdp();
    try {
      const second = await startReferenceIdp();
      try {
        assert.equal(first.clientId, "opensesame-upstream");
        assert.notEqual(first.clientSecret, process.env.OPENSESAME_UPSTREAM_CLIENT_SECRET);
        assert.notEqual(first.clientSecret, second.clientSecret);
        assert.equal(first.oauth2.clientId, "mock-oauth2-app");
        assert.notEqual(first.oauth2.clientSecret, process.env.OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_SECRET);
        assert.notEqual(first.oauth2.clientSecret, second.oauth2.clientSecret);
        assert.equal(first.oauth2.userId, 4242001);
        assert.equal(first.oauth2.login, "mock-octocat");
        const grant = await obtainReferenceOidcGrant(first);
        const key = await importJWK(first.publicJwk, "RS256");
        const verified = await jwtVerify(grant.idToken, key, { issuer: first.issuer, audience: grant.clientId });
        assert.equal(verified.payload.email, "mock@example.com");
        assert.equal(verified.payload.email_verified, true);
        assert.equal(verified.payload.name, "Mock User");
        first.setSubject("mock-user-1");
        const again = await obtainReferenceOidcGrant(first);
        const verifiedAgain = await jwtVerify(again.idToken, key, { issuer: first.issuer, audience: again.clientId });
        assert.equal(verified.payload.sub, verifiedAgain.payload.sub);
        const saml = new URL(first.saml.ssoRedirectUrl);
        saml.searchParams.set("SAMLRequest", Buffer.from('<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_test"/>').toString("base64"));
        const missingAcs = await fetch(saml, { redirect: "manual" });
        assert.equal(missingAcs.status, 400);
        assert.equal((await missingAcs.json()).error_description, "no AssertionConsumerServiceURL and no default ACS");
      } finally { await second.close(); }
    } finally { await first.close(); }
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        NODE_ENV: "test",
        OPENSESAME_UPSTREAM_CLIENT_ID: "ambient-client",
        OPENSESAME_UPSTREAM_CLIENT_SECRET:
          randomBytes(24).toString("base64url"),
        OPENSESAME_UPSTREAM_REDIRECT_URIS: "https://ambient.example/callback",
        OPENSESAME_MOCK_IDP_USER_SUB: "ambient-subject",
        OPENSESAME_MOCK_IDP_USER_EMAIL: "ambient@example.invalid",
        OPENSESAME_MOCK_IDP_USER_NAME: "Ambient Name",
        OPENSESAME_MOCK_IDP_USER_EMAIL_VERIFIED: "false",
        OPENSESAME_MOCK_IDP_SAML_ACS_URL: "https://ambient.example/acs",
        OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_ID: "ambient-oauth-client",
        OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_SECRET:
          randomBytes(24).toString("base64url"),
        OPENSESAME_MOCK_IDP_OAUTH2_USER_ID: "7",
        OPENSESAME_MOCK_IDP_OAUTH2_LOGIN: "ambient-login",
      },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
}, 40_000);

it("does not open the process's configured log destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "reference-idp-log-"));
  const logPath = join(dir, "operator.log");
  const keyPath = join(dir, "operator.key");
  try {
    const require = createRequire(import.meta.url);
    const entry = new URL("./testkit.ts", import.meta.url).href;
    const script = `
      import { obtainReferenceOidcGrant, startReferenceIdp } from ${JSON.stringify(entry)};
      const idp = await startReferenceIdp();
      try { await obtainReferenceOidcGrant(idp); }
      finally { await idp.close(); }
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          NODE_ENV: "test",
          OPENSESAME_LOG_FILE: logPath,
          OPENSESAME_LOG_KEY_FILE: keyPath,
        },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
