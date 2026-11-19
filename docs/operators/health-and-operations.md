# Operations (identity + dual-plane)

## Health
Identity API:
- Liveness: `GET /v1/health/live` answers `{"status":"ok"}`.
- Readiness: `GET /v1/health/ready` answers `{"status":"ready"}` once the system
  owner principal exists and, with a database, every declared table reads and a
  write/read/delete round trip succeeds; otherwise `503 {"status":"not_ready"}`.
  It does not probe external IdPs.

Host API:
- Liveness: `GET /health/live` (also `GET /api/v1/health`) answers `ok`.
- Readiness: `GET /health/ready` answers `200 {"status":"ready"}` or
  `503 {"status":"not_ready","reason":…}` (`authority_quorum`,
  `authority_unavailable`, or `demo_bootstrap_forbidden_in_production`).
- `GET /health/authority` and `GET /health/degraded` answer `{"ok":…}`, the
  authority quorum.
- `GET /health/providers` is operator-gated: whether OpenFGA and OpenBao are
  configured and healthy.

## Local ports
| Service | Port |
|---------|------|
| Identity control-plane | 8788 |
| Mock upstream IdP | 9090 |
| Authority gateway | 8787 |
| RP examples | Vite defaults (see `npm run dev`) |

## Backup / restore
- PostgreSQL logical dump is the identity store backup.
- Back up issuer signing material and claim-token pepper separately.
- Claim bearer secrets cannot be reconstructed from digests after catastrophic loss; in-flight claims must be re-issued.
- Issuer URL changes break RP trust; treat issuer as sticky.

## Host replicas
Replicas serving the same Host authority must use the same durable SQLite
database and resource URL. The database filesystem must support SQLite's
locking and durability requirements for every replica; separate local files
do not form a shared authority. Each replica must also use the same provisioned
`OPENSESAME_CLAIM_PEPPER`. A replica refuses to start when its resource or
pepper differs from the database's binding. Device approvals, failed-guess
limits, native sessions, and membership withdrawals are stored in that database,
so these device and native-session operations need no load-balancer affinity.

Back up the database together with its associated keys, using an SQLite-aware
backup procedure. The claim pepper also protects other data; see
[logs and event sealing](log-and-event-sealing.md) before changing it.

## Agent-hooks and web-login housekeeping (ADR 0159)
The Host runs background actors for these, none of which need configuring:

- **Decision audit retention.** Every verdict `POST /api/v1/agent-hooks/intercept`
  answers is a value-blind row (read it with `GET /api/v1/agent-hooks/decisions` or
  `opensesame hooks decisions`), kept 90 days. `OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS`
  (1 to 3650) changes it; a bad value is ignored with a warning, never read as
  "forever". Decisions are not on the backup outbox, so agent traffic never
  reaches the backup actor.
- **Run retention.** Hourly (`OPENSESAME_RETENTION_TICK_SECONDS`), a web-login run
  past its `expires_at` (seven days) is removed with its sealed log, step queue and
  hook records in one transaction.
- **Runs are tracked tasks.** The lifecycle scanner *starts* a web-login run and moves
  on. At most `OPENSESAME_WEB_LOGIN_MAX_RUNS` (8) run at once per process and
  `OPENSESAME_WEB_LOGIN_MAX_RUNS_PER_ORG` (2) per organization; the rest wait
  holding nothing. A run's outcome is published by the run itself.
- **Reaper.** At startup, and every `OPENSESAME_WEB_LOGIN_SWEEP_SECONDS` (60), a run
  still open past the policy lease (17 minutes) is closed, and a rotation job still
  running past it parks as `reconciliation_required` — *the run stopped before it
  settled; whether the site received the change is unknown*. Treat that detail as
  "may have submitted", never as "did not".

A person who asks for the page mid-run (`POST /api/v1/agent/runs/{id}/handoff`) parks
the run at its next safe point — never between the presence assertion and the submit
— and nothing is queued for their browser while they hold it.

## Key rotation
Overlap active/retiring signing keys in JWKS until max token lifetime elapses. Pairwise subjects must not change when signing keys rotate (ADR 0011).

## Membership-withdrawal rollout

Pause membership removal and role-change traffic before this rollout. Roll out
the Identity API first: it sends the exact membership incarnation, authority
revision, and stable withdrawal ID. Legacy Hosts ignore those extra request
fields and may return `200`, but their response does not attest a durable
replica-shared fence, so upgraded Identity keeps the mutation pending.

Drain and replace **every** legacy Host while membership mutations remain
paused. Query each load-balancer backend directly (never sample through the
load balancer) and require `GET /health/ready` to return HTTP `200` with
`membership_withdrawal_fence: 1`. A legacy replica omits that capability and
can continue accepting a session cached before another replica committed the
shared tombstone. One upgraded replica's durable withdrawal acknowledgement
therefore proves protocol compatibility, not fleet readiness.

Resume membership mutations only after the backend inventory and direct probes
show no legacy target and the load balancer has stopped routing to every drained
instance. After that barrier, a request routed to any replica commits or
observes the shared tombstone and returns the exact durable attestation. Do not
deploy a Host that requires the new request fields before Identity can send
them: legacy Identity receives a non-success response and fails closed, but
membership changes remain unavailable until Identity is upgraded.

## Compose
```bash
docker compose -f ops/compose/docker-compose.yml up
# Keycloak is already in the default compose file for optional enterprise OIDC brokering.
```

Identity-plane apps can run via `npm run dev` without Docker when using memory/local Postgres.
