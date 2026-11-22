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

## Rollback checkpoints and recovery

Native `.osseal` entries use an authenticated high-water checkpoint outside
the Git-backed store root. It is bound to the store's canonical path and
identity, records revisions and deletion tombstones, and is rekeyed with the
vault root. Restoring only the Git checkout cannot make an older genuine entry
current while the outside checkpoint remains intact. Protect that checkpoint
from rollback independently: restoring or modifying both the store and its
outside checkpoint together defeats this protection.

The checkpoint includes an authenticated committed-epoch marker and redundant
witness slots. The marker must be preserved independently with the slots: it
prevents a missing or older slot from silently becoming current, but cannot
detect rollback of the marker and witness together. Root rotation prepares a
new-key marker and then durably marks the old-key marker pending before the
key-file commit. The old key cannot perform ordinary operations afterward,
even if finishing the second witness slot is interrupted. A missing or damaged
marker on a migrated store requires restoring the trusted outside checkpoint;
ordinary reads and writes never recreate it.

The checkpoint lives in the platform local-data directory under
`OpenSesame/sealed-store-rollback-witnesses`. Disaster-recovery backups must
preserve it with the key material. A missing checkpoint for an anchored store
fails closed; restore it instead of trusting the rollbackable revision JSON.
For a pre-checkpoint store, verify the current checkout independently, migrate
any legacy unbound entries with `opensesame vault pass protect migrate-legacy NAME
--trust-source`, then run:

```bash
opensesame vault pass migrate-rollback-anchor --accept-current-state
```

The ceremony trusts the selected checkout as its initial high-water state; it
cannot prove freshness. The same ceremony explicitly upgrades an existing
version-one entry checkpoint that predates the commit marker. Independently
verify both that checkpoint and the selected checkout before upgrading. A lost
marker must not be replaced by accepting an old checkpoint: if all newer
outside evidence has also been lost or restored, the ceremony cannot
cryptographically distinguish that state from a genuine legacy checkpoint.
All clients sharing a store must be upgraded before concurrent use; older
clients do not maintain the marker and can leave the checkpoint unusable or
accept stale state.

For a store that already has a version-one checkpoint, upgrade that checkpoint
first. Then independently verify and migrate any legacy unbound entries with
`protect migrate-legacy NAME --trust-source`; their repair requires the upgraded
checkpoint. A store with no checkpoint uses the pre-checkpoint order above.

If rotation stops after marking the old key pending, preserve the staging
directory and follow its `plan.json` to resolve the interrupted file swaps and
key file. Independently verify which root key and checkout should be current;
do not select an old key after a completed rotation merely to bypass its
revocation. Once the verified state is restored and the staging directory is
removed, rerun `migrate-rollback-anchor --accept-current-state` with the
verified current key. That explicit ceremony can reactivate an authenticated
pending witness; it cannot establish which key generation is freshest.

Rotations that reissue recovery keys return the committed outcome with
`git_deferred` set before running any Git command or hook. The CLI prints and
flushes the keys through a post-commit callback before redundant-slot repair
and filesystem cleanup, then reports that the encrypted files need a manual Git
commit and backup. Save the keys, commit the current encrypted store files, and
back them up; do not rotate again merely to retry Git. If recovery output fails,
unlock the current store after fixing output and add a new recovery protector.
Library callers needing the same early delivery can use
`rotate_store_root_with_commit`; the callback holds the store lock and may block
cleanup, so it must return promptly. A crash before callback delivery can still
prevent newly reissued recovery keys from reaching the caller.

Rotations without reissued keys retain automatic Git behavior. A Git
enumeration, staging, or commit failure occurs after the new root and ciphertext
are already committed and is returned in `git_error`; non-fatal backup status
is returned in `git_notice`. The CLI reports a Git error with a failure status.
Repair the repository, commit the current encrypted store files, and back them
up; do not rotate again merely to retry Git. Git hooks and automatic pushes can
still delay this automatic step.

Store auto-commits are limited to the selected encrypted files and supported
configuration; unrelated staged changes remain in the index. The installed
Git must support `--pathspec-from-file` and `--pathspec-file-nul` for both
`add` and `commit`; an older Git fails instead of committing unrelated paths.

Keyed attachment reads, writes, removal, garbage collection and rotation also
use the outside checkpoint. For an existing entry-only checkpoint, verify the
complete attachment inventory and its chunks independently, then rerun the
explicit `migrate-rollback-anchor --accept-current-state` ceremony above to
anchor it. Until then keyed attachment operations fail closed. Every client
that reads or writes the store must be upgraded: older clients ignore attachment
checkpoints and can read stale data or make changes newer clients reject.
The local attachment revision JSON remains unauthenticated. Passphrase-free
replication cannot authenticate the header or outside checkpoint and therefore
cannot establish freshness.
Names normalize path components and surrounding whitespace, but case aliases
on case-insensitive filesystems remain a limitation. Atomic replacement and
directory syncing provide only the durability of the underlying filesystem.

If a removal stops after recording a tombstone but before unlinking, retry it.
To retain a verified entry instead, inspect Git history and explicitly restore
it, or run `opensesame vault pass protect recover-ciphertext NAME --trust-source`
(add `--attachment` for an attachment). Recovery re-authenticates and reseals
at a newer revision but cannot establish freshness: the flag is an explicit
choice to trust the selected ciphertext even if it is an old replay. Verify
its provenance first; restore missing attachment chunks separately.

An interrupted new attachment can leave a live checkpoint before its manifest
exists. Listing, garbage collection and rotation then fail closed. Restore the
verified source with `opensesame vault pass attach add NAME FILE`; this deliberately
creates a newer attachment and does not prove what went missing. If restoring
an older encrypted manifest instead, independently verify it and use the
explicit `recover-ciphertext --attachment --trust-source` ceremony above.


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
