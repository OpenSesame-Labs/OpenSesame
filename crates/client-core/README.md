# opensesame-client-core

The client-core SDK facade for the Client plane: local end-to-end encryption and
ciphertext sync cursors, built natively and, behind a feature, for Wasm. A
client seals blobs under its sync key (XChaCha20-Poly1305), and a `SyncStore`
tracks what to push and what it has already applied by epoch. The server only
ever stores ciphertext; persisted state is sealed blobs, never plaintext.
Devices that exchange these blobs must have the same client-held sync key;
how that key is delivered to authorized devices is outside this SDK.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway), for the `SyncBlob` shape in
  the sync routes (`routes/sync.rs`, `routes/sync_blobs.rs`). The TypeScript
  package [`@opensesame/client-core`](../../packages/client-core) mirrors its
  sync shapes by hand; it does not load this crate.
- **Builds on:** [`opensesame-core`](../core) and
  [`opensesame-human-vault`](../human-vault), both re-exported (`core`,
  `human_vault`).
- A snapshot file is as sensitive as the vault: sealed AEAD blobs only, never
  plaintext and never a vault recovery key. `assert_ciphertext_only_json`
  checks a snapshot's JSON, and `refuse_deployment_seal_as_wrap_key` refuses a
  deployment seal offered as a wrap key.
- Key material zeroizes on drop.

## Surface

| Item | What it is |
|---|---|
| `DeviceKey` | `generate`, `from_bytes`, `as_bytes` |
| `seal`, `open`, `open_sync_blob` | General AEAD and the versioned sync-blob opener |
| `SyncStore` | `new(device_id)`, `put_local`, key-verified `apply_remote`, `collect_outgoing(since)`; authenticated persistence through `to_persisted_json` / `from_persisted_json` and, off `wasm32`, `save_path` / `load_path` |
| `SyncCursor`, `SyncBlob` | The sync wire shapes |
| `snapshot` | `CiphertextSyncSnapshot` (`validate`, `to_json`, `from_json`), `SyncStore::export_ciphertext_snapshot` / `import_ciphertext_snapshot`, `SNAPSHOT_FORMAT`, `SNAPSHOT_VERSION` |
| `wit_contract::PACKAGE` | `opensesame:client@1.0.0` — the `spec/wit/client` world |
| `wasm` (feature `wasm-bindgen`) | `WasmDeviceKey`, `WasmSyncStore`, `wasm_seal`, `wasm_open`, `wit_package` |

## Sync format and migration

Version 2 sync envelopes authenticate both the blob ID and epoch before a
remote blob can alter a store. Persisted stores also authenticate their cursor
and contents. The key is required when applying remote data, importing a
snapshot, saving, or loading. Keep the client-held key available through the
application's existing secure key custody; the SDK does not store it in the
snapshot. Raw `seal`/`open` remain general-purpose APIs; use `open_sync_blob`
for sync envelopes.

A successful authenticated save or load binds a store to that key, including
when the store is empty. Different authenticated ciphertext for the same item
and epoch is rejected as a conflict without applying any of the batch; an
identical retry is accepted. Applications must reconcile such concurrent edits
instead of silently choosing a version.

The Rust SDK limits one store or snapshot to 512 blobs and 32 MiB of total
ciphertext. Each blob is limited to 2 MiB, IDs to 128 bytes, and encoded JSON
to 129 MiB. Inputs exceeding a limit are rejected rather than partially
applied; separate project-scoped stores and snapshots can be used where
appropriate. Native loads
read only regular files and stop at the JSON limit. These bounds apply to the
explicit legacy migration paths as well.

Version 1 ciphertext and persisted stores cannot authenticate epochs. Normal
loading and sync reject them. To retain existing data, stop sync on all devices,
select a legacy persisted store or snapshot whose provenance and freshness you
trust, and explicitly use `migrate_trusted_legacy_json` or
`migrate_trusted_legacy_snapshot` with its key. These methods re-seal the
selected entries at epochs above the source cursor and return a new store;
retain the original until the migrated store is backed up and the devices and
server have been coordinated. A server-provided or otherwise untrusted export
is not a safe migration source. Migration cannot prove old epoch metadata or
detect a rollback that occurred before migration.

Authenticated blobs and persisted state detect metadata substitution, but an
attacker who replaces an entire store with an older, valid copy can still roll
it back without an independent freshness witness. `collect_outgoing` returns
all current blobs for reconciliation regardless of the supplied cursor: a
single device epoch cannot establish which updates from other devices have
been seen. Callers uploading to Host must chunk reconciliation into the Host's
request limits and reconcile stale or conflicting entries before retrying.

| Cargo feature | Effect |
|---|---|
| `wasm-bindgen` | Adds `wasm-bindgen`, `serde-wasm-bindgen`, `js-sys` and the `wasm` module |

On `wasm32`, `getrandom` is built with its `js` feature.

## Develop

```bash
cargo test -p opensesame-client-core
cargo check -p opensesame-client-core --features wasm-bindgen
```

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology and the SDK facades
- [`spec/wit/client/world.wit`](../../spec/wit/client/world.wit) — the WIT world
