# @opensesame/identity-testkit

The Identity testkit starts the **real** HTTP dispatcher and OIDC issuer with
isolated in-memory state on an available loopback port. Point a client at
`baseUrl` and always close the server:

```ts
import { startIdentityTestServer } from "@opensesame/identity-testkit";
import { createControlPlaneClient } from "@opensesame/sdk-cli";

const identity = await startIdentityTestServer();
try {
  const client = createControlPlaneClient({ baseUrl: identity.baseUrl });
  const guest = await client.createProvisionalSession();
  // Exercise the SDK and the real Identity routes with this session.
} finally {
  await identity.close();
}
```

Start one instance per test to isolate in-memory data. Each instance generates
its own claim pepper and OIDC issuer key, does not inherit the host database or
upstream provider configuration, and does not accept principal IDs as bearer
tokens. Its default Host address is disabled; upstream sign-in and delivery
integrations are not configured. The application clock can be supplied for
expiry tests.

The logger and AgentAuth runtime also read ambient process configuration. The
testkit therefore refuses to start when `OPENSESAME_LOG_FILE`,
`OPENSESAME_LOG_KEY_FILE`, `OPENSESAME_AGENT_AUTH_SIA_JWK`, or
`OPENSESAME_JWKS_JSON` is set, or when the process is in production mode. Do
not change these variables while a test server is running. AgentAuth's signing
runtime is process-global: if another in-process service has already initialized
it, test instances share that key. Use a separate process for tests that require
independent AgentAuth signing keys.

For federation tests use the separate
[`mock-upstream-idp`](../../tools/mock-upstream-idp) testkit. This local setup
does not establish production Postgres durability, TLS, real external delivery,
or a browser/passkey sign-in; those require their existing integration gates.
