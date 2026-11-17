# @opensesame/api-client

The typed TypeScript client for the Host API (`crates/gateway`, `:8787`). One
factory, `createApiClient`, returns methods for connections, integrations,
sync targets, secret configs, invoke, sync, tasks, receipts, delegations,
relay, certificates, rotations, the project changelog, the backup target and
the driver half of a sandboxed run (claim and settle a step, read the hook records).
Provider, connection, integration, sync-target and secret-config responses are
parsed with the `@opensesame/contracts` schemas; `health`, `discover` and
`probeDaemon` build their own result types, the sandboxed-run methods decode
their own wire shapes, and the remaining methods return the decoded JSON as a
boundary value.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core), [`packages/cli`](../cli),
  [`apps/browser-extension`](../../apps/browser-extension),
  [`packages/mcp-client`](../../packages/mcp-client) and
  [`packages/mcp-host`](../../packages/mcp-host).
- **Builds on:** [`@opensesame/contracts`](../contracts) (response schemas),
  [`@opensesame/client-core`](../client-core) (sync blob and cursor types) and
  [`@opensesame/os-domain`](../os-domain).
- A base URL must be HTTPS, or HTTP on loopback; anything else throws at
  construction. `probeDaemon` only probes a loopback URL.
- DPoP proofs are opt-in (`dpop: true` or a supplied key pair), carry `ath`
  when a token is present, and retry only on an explicit nonce challenge.

## Surface

| Export | What it does |
|---|---|
| `createApiClient({ baseUrl, accessToken?, dpop?, fetchImpl? })` | The client; `ApiClient` is its type |
| Core methods | `health`, `discover`, `whoami`, `listProviders`, connection CRUD plus `authorizeConnection` / `refreshConnection` / `revokeConnection` / `bindConnection` / `unbindConnection` / `setConnectionCredential` / `connectionEvents`, integrations, sync targets, secret configs and versions, `invoke`, `syncPush`, `syncPull`, `syncPullPages`, `syncReadPage`, `probeDaemon` |
| Mixed-in groups | `tasks.ts`, `receipts.ts`, `delegations.ts`, `relay.ts`, `certs.ts`, `rotations.ts`, `changelog.ts`, `backup.ts`, `agent-runs.ts` |
| Runs | `listAgentRuns`, `getAgentRun`, `claimRunnerStep` (`null` on 204), `settleRunnerStep`, `readRunHookRecords`; `decodeRunnerStepRequest` (strict: an unknown tag, a missing, mistyped or extra field is `null`), `RunnerStepRequest` / `RunnerStepOutcome` mirroring `crates/rotation-web` `StepRequest` / `StepOutcome`, and `RunnerApiError` carrying status and code |
| Helpers | `createDpopKeyPair`, `accessTokenHash`, `normalizeHttpBaseUrl`, `normalizeLoopbackBaseUrl`, `pullSyncPages`, `readSyncPage` |

## Develop

```bash
npm run test -w @opensesame/api-client
npm run typecheck -w @opensesame/api-client
```

The Host API's OpenAPI description is
[`spec/openapi/host-api.yaml`](../../spec/openapi/host-api.yaml).

## Scripted Host HTTP stub

Tests can opt in to `@opensesame/api-client/testkit`. The stub implements the
same `fetchImpl` interface used by the real client; it never opens a listener
or makes a network request. Register each expected method and pathname, and
the handler can inspect its `Request` (including query, headers and body):

```ts
import { createApiClient } from "@opensesame/api-client";
import { createHostApiStub } from "@opensesame/api-client/testkit";

const host = createHostApiStub();
try {
  host.route("GET", "/api/v1/connections", () =>
    Response.json({ connections: [] }),
  );
  const client = createApiClient({ baseUrl: host.baseUrl, fetchImpl: host.fetchImpl });
  await client.listConnections();
} finally {
  await host.close();
}
```

An unregistered method/path or a different origin fails immediately; there
are no built-in successful routes. `reset()` removes routes and invalidates
handlers that have not returned a response, and `close()` disposes of the
stub. Once a handler returns a response, its body is owned by the caller;
reset and close cannot cancel a body already being read. Await or cancel such
bodies before resetting or disposing the stub. Separate instances have
separate state. Tests may register a handler for a refusal or return a sequence
of responses from a closure. The caller is responsible for keeping test data
synthetic; the stub itself does not record requests.

This is a programmable stub, not a simulated gateway. It does not implement
authentication, authorization, DPoP, persistence, transport security, or
the Host's other behavior, and a scripted success proves none of them. Use
the real Host integration tests for those properties and update scripts when
the actual API contract changes.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology; the Host and Identity APIs stay separate
- Server: [`crates/gateway`](../../crates/gateway)
