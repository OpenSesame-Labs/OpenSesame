# opensesame-sealed-store

The git-native hierarchical sealed secret store behind `opensesame pass`, with
`pass` parity. Ciphertext files live under a store root (default
`~/.password-store`), one per entry, committed to git and pushed to a backup
remote. Agents never receive plaintext through the surface Host invoke paths
use; reveal is a human CLI concern.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (the `pass` verbs, attachments,
  root protection, OTP), [`crates/daemon`](../../crates/daemon) (autofill of
  produced passwords), [`crates/pm-bridges`](../../crates/pm-bridges),
  [`opensesame-connector-host`](../connector-host),
  [`opensesame-kdbx-bridge`](../kdbx-bridge),
  [`opensesame-vault-item-types`](../vault-item-types), and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`attachment_chunk`).
- **Builds on:** [`opensesame-human-vault`](../human-vault) (the E2EE envelope,
  item and vault-root keys, root protection) and
  [`opensesame-authenticator-core`](../authenticator-core) (TOTP/HOTP and
  `otpauth://` trailers). `age` for age-format entries.
- `git`, `gpg`, `sops` and `ykman` are external processes, not linked
  libraries. SOPS is resolved only from an absolute `OPENSESAME_SOPS_BIN`, and
  PIV discovery never runs a destructive `ykman` command.

## Surface

| Area | Items |
|---|---|
| Store | `init_store`, `init_store_key`, `unlock_store_key`, `list_names`, `StoreRoot`, `resolve_store_dir`, `FormatHint` (`Osseal`, `Gpg`, `Age`) |
| Entries | `Entry`, `apply_secret_update`, `rotate_secret_entry`, `UpdateOptions`, `generate_password`, `entry_history`, `restore_entry`, `produce_entry` / `Produced` (the one facade for an entry's password, [ADR 0174](../../docs/adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)) |
| Formats | `seal_osseal` / `open_osseal` (`OSSEAL1` envelope), `encrypt_age_file` / `decrypt_age_file`, `encrypt_gpg_file` / `decrypt_gpg_file`, `sops_encrypt` / `sops_decrypt` |
| Git | `ensure_git_repo`, `auto_commit`, `push_backup`, `set_remote`, `set_auto_push`, `git_passthrough`, `GIT_TOKEN_ENV` |
| Attachments | `AttachmentManifest`, `ChunkRef`, `GcOutcome`, `MAX_ATTACHMENT_BYTES` — chunked, content-addressed, each chunk sealed separately |
| Tombs | `TombRegistry`, `TombEntry`, `load_tomb_registry`, `resolve_tomb_paths`, `ensure_personal_project_tomb` |
| Root protection and rotation | `protect_*`, `rotate_store_root`, `Recipients`, `discover_piv_age` |
| Pages bridge | `parse_manifest`, `seal_manifest` — seal a Pages path manifest into entries and one commit |
| Paths | `logical_to_relative`, `relative_to_logical`, `ObjectStore`, `FsObjectStore`, `assert_confined_rel` |

## Revision-state limits and recovery

Native entry and attachment revisions are checked against local JSON files.
An intact local counter can detect replacement with an older ciphertext, and
removal advances it before unlinking so copied-back ciphertext at the same
logical name is rejected.
On the first authenticated attachment read or listing without a local counter,
the observed revision is recorded before the manifest is returned; garbage
collection does the same while holding its existing store lock. Passphrase-free
replication refuses an advertised manifest revision that disagrees with an
existing counter, but neither the header nor the counter proves freshness;
replication does not authenticate manifests and rotation does not initialize
these counters.
These files are **not authenticated, independently witnessed, or included in
the Git backup**. Anyone able to alter or remove them can restore old valid
ciphertext; a fresh clone has no earlier local counter to compare with. Even an
authenticated file stored alongside the ciphertext cannot detect replay of an
entire old store. Defending against that attack requires an independently held,
non-rollbackable freshness witness, checked on every relevant operation; this
store does not currently provide one. Do not rely on the revision files as a
security boundary against local or backup rollback.

Revision keys normalize logical path components, including surrounding
whitespace. They do not yet unify case aliases on case-insensitive filesystems,
so even an intact sidecar does not protect against every alternate path
spelling on those filesystems.

Revision updates use atomic replacement, and new clients serialize updates to
avoid losing counters. On filesystems that do not support syncing a directory,
power-loss durability depends on the filesystem. Upgrade every client accessing
a store before concurrent use: older clients can initialize revision state
without taking the mutation lock, and do not record entry-removal tombstones.
The sidecar format remains compatible, but downgrades weaken these protections.

If removal is interrupted after recording its counter but before unlinking,
the file remains present but will not open as the current version. Retry the
same removal to finish it. For a Git-backed entry that should instead be
retained, inspect `opensesame pass history NAME` and deliberately restore the
chosen commit with `opensesame pass restore NAME --rev COMMIT`; it is re-encrypted
at a newer revision. This is an explicit choice to trust that historical
content. Alternatively, if the intact on-disk ciphertext is independently
verified as the version to keep, run
`opensesame pass protect recover-ciphertext NAME --trust-source` (add
`--attachment` for an attachment). This works without a Git backup and reseals
the file at a newer revision. It authenticates the ciphertext's name and
contents but **cannot establish its freshness**: `--trust-source` is an
explicit decision to accept that file even if it is an old replay. Do not use
it until its provenance and version have been verified independently. Missing
attachment chunks still need to be restored from a trusted backup.

## Develop

```bash
cargo test -p opensesame-sealed-store
npm run test:mutation:rust   # src/attachment.rs is in the mutation scope
```

`tests/manifest_snapshot.rs` pins the manifest shape with `insta`. The store is
driven end to end from the CLI; see the `pass` section of
[`AGENTS.md`](../../AGENTS.md).

## Related

- [ADR 0037](../../docs/adr/0037-git-sealed-store.md) — git sealed store
- [ADR 0038](../../docs/adr/0038-multi-tomb-sealed-store.md) — multi-tomb sealed store
- [ADR 0054](../../docs/adr/0054-file-attachment-storage.md) — file attachment storage
- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md) — password-manager ecosystem bridging
- [`docs/security/audits/2026-09-23-sealed-store-root-protection.md`](../../docs/security/audits/2026-09-23-sealed-store-root-protection.md)
