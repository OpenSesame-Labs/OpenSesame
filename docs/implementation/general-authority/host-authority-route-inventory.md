# Host authority evaluation route inventory (GA-H-01)

Standing inventory of Host HTTP that participates in hierarchical authority
evaluation / mutation. Storage writers and OpenFGA projection stay as named in
[`storage.md`](storage.md). Capability ids are the `authority.domain.*` entries
in `packages/capability-registry`.

## Evaluation path (already landed)

| Surface | Evidence |
|---|---|
| `ValidatedGrantChain` + authz decide | `cargo test -p opensesame-authz --lib` |
| Broker invoke + receipt binding | `cargo test -p opensesame-broker --lib` |
| Intent budget / projection helpers | `crates/gateway/src/routes/intents_*.rs` |

## Access-domain & offer HTTP

Operator bearer/header or an owner/admin session may call these routes. The
`{organization}` path must equal the caller's realm (`X-OpenSesame-Organization`
for operators; the session's organization for humans). Realm mismatch returns
`404 not_found` and ordinary members receive `403`.

| Method | Path | Storage |
|---|---|---|
| `GET` | `/api/v1/organizations/{organization}/access-domains` | `list_access_domains` |
| `POST` | `/api/v1/organizations/{organization}/access-domains` | `create_access_domain` |
| `GET` | `/api/v1/organizations/{organization}/access-domains/{id}` | `access_domain` |
| `POST` | `/api/v1/organizations/{organization}/access-domains/{id}/reparent` | `reparent_access_domain` |
| `POST` | `/api/v1/organizations/{organization}/access-domains/{id}/terminate` | `terminate_access_domain` |
| `POST` | `/api/v1/organizations/{organization}/grants/{grant_id}/authority` | `issue_authority` |
| `POST` | `/api/v1/organizations/{organization}/grant-offers/{id}/activate` | `activate_grant_offer` |
| `POST` | `/api/v1/organizations/{organization}/grant-offers/{id}/revoke` | `revoke_grant_offer` |

Create accepts optional `id` (otherwise `adom:…`), `parent_id`, and
same-realm `project_id`. Reparent and terminate require `expected_revision`
(CAS); the schema rejects cross-realm parents and the route returns `422
refused`. Issuing `credential.export`, `policy.edit`, or
`raw_credential_export` authority requires an owner/operator rather than an
admin, and `delegation_depth_remaining` must be 0–2.

The access-domain and offer routes write no OpenFGA tuples. Their storage
transaction emits the outbox event. Grant issue is the exception: after commit,
and only when OpenFGA is configured, it calls `project_grant_live`; failed
projection remains unmarked and is logged.

Contract pins:

```bash
cargo test -p opensesame-gateway --bin opensesame-gateway -- routes::access_domains::tests
cargo test -p opensesame-gateway --bin opensesame-gateway -- routes::grant_offers::tests
```

Router merge: `crates/gateway/src/routes/local_authority_routes.rs` merges
`access_domains`, `authority_grants` and `grant_offers` (and `mod.rs` merges that
router); `contract.rs` includes all three sources so undocumented routes fail CI.

## Grant issue HTTP

| Surface | Evidence |
|---|---|
| `POST .../grants/{grant_id}/authority` | `cargo test -p opensesame-gateway --bin opensesame-gateway -- routes::local_authority_routes::authority_grants::tests` |

Records sidecar authority on an existing `grants` row (`issue_authority`). Does not insert the legacy envelope.

All routes above are documented in `spec/openapi/host-api.yaml`. The generated
`packages/api-client` does not yet expose typed methods; add them when a
consumer needs them. Offer create/list/get remain storage-ready but deliberately
unexposed, while activate/revoke operate on an existing offer.

## Deliberately not on this inventory

- Live OpenFGA writes from the access-domain and offer routes — none. Only the
  grant-issue route projects tuples, after its commit and when OpenFGA is
  configured (`crates/gateway/src/openfga_project.rs`, GA-F-04).
- Identity `/v1/authority/*` — Identity plane (GA-I-01).
- Offer create/list/get HTTP — storage-ready (`create_grant_offer`); activate/revoke only today.

## Status

Evaluation + AccessDomain/offer + grant-issue HTTP are inventory-complete for GA-H-01.
