# Host source-trust history

This workflow is a **prototype pending independent review and revalidation after restacking**. It records
every trust-profile name the Host has accepted from its workload identity
source, so a later local bundle in the Host's generation manager cannot claim
a previously source-owned name. A configured Host transport requires the
record even after a switch to PEM or managed identity, or when only service
bindings are configured. On Unix, a Host with no transport configuration still
takes a file lease when its database is file-backed; unconfigured in-memory
startup is unchanged. On Windows, configured transport and the initializer
currently fail closed because their file-identity lease has not been validated;
an unconfigured Host retains its existing startup behavior.

## Fresh installation and legacy upgrade

1. Stop every Host and any other writer using this trust-owner database,
   including older binaries and raw SQLite writers. The Unix file lease fences
   only cooperating current processes on the supported filesystem. Review the
   complete set of names ever accepted from
   the source, including domains since removed. For a truly new owner with no
   earlier source, the complete set is empty. Do not derive an apparently
   complete history solely from the current Workload API snapshot. If the
   complete old history cannot be established, the operator cannot make this
   attestation safely; keep the configured transport stopped.
2. Set `OPENSESAME_DB` to the intended durable SQLite database. For a fresh
   file, first create its parent directory and use a URL with `?mode=rwc`, for
   example `export OPENSESAME_DB='sqlite:/var/lib/opensesame/host.db?mode=rwc'`.
   SQLx does not create a missing file by default. Start the Host once with its
   normal security configuration and valid transport material. Normal startup
   creates/opens the file and applies the usual embedded schema migrations;
   a configured transport then refuses to start because history is absent.
   The Host can also fail earlier on another configuration error; fix that
   error without assuming the history was initialized. Stop the process again.
   On an existing installation, normal startup may apply pending migrations
   before the same history refusal. Assess those normal migrations as part of
   the upgrade. This initial start does not attest or invent history.
3. Create a reviewed JSON file such as the following. Replace the actor,
   change reference, and names with the actual attested complete history.
   This document is an operator assertion; the tool cannot verify completeness.

   ```json
   {
     "owner": "host-tls",
     "actor": "operator@example.test",
     "change_ref": "change-123",
     "names": ["example.test", "partner.test"]
   }
   ```

   Run the explicit offline action while all Hosts and other writers remain
   stopped:

   ```sh
   opensesame host trust-history-init \
     --database-url "$OPENSESAME_DB" \
     --attestation /secure/operator/source-trust-history.json \
     --attest-complete-and-hosts-stopped
   ```

   The initializer requires an existing file and schema even if the URL says
   `mode=rwc`; it runs no migrations, starts no listener, and will not replace
   an existing record. It accepts at most 512 KiB and validates the document.
   A missing, corrupt, oversized, or unattested record, unsafe
   SQLite durability settings, or an unavailable owner lease stops startup.
   Do not delete a record to make initialization succeed.
4. Start the configured Host. The history is loaded before the trust manager is
   exposed. If its initial deployment-provided trust bundle uses a reserved
   name, startup refuses it; an in-process removal endpoint is then unavailable.
   Resolve that collision through a separately reviewed offline configuration
   cleanup or namespace migration before retrying. Keep unrelated profiles.

An enabled stored profile whose name is reserved by the source is quarantined
on adoption while unrelated stored profiles can still be used. The operator
trust endpoint reports `quarantined_stored_profiles` and `reconciled`; the
values are sampled diagnostics, not an atomic authorization decision. A PUT
rejects a reserved enabled profile even if it was already quarantined, so
remove or disable it before updating unrelated entries, subject to the
existing binding-removal guard and audited force option. A canceled PUT can
commit its stored update before local activation, and other processes adopt
store changes on their refresh cadence.

## Boundaries

The record and lease do not prove an operator's list complete. Current
file-backed Hosts and the offline initializer take the same nonblocking private
file lease before opening SQLite. A second cooperative process is refused; a
lease remains held until process exit even after failed startup or teardown.
Retry that database in a new process. This deliberately prevents two current
Hosts from sharing the same supported file concurrently, even when one has no
transport configured. A process accepts at most 256 distinct file-backed Host
database claims before it must be restarted.

The Unix guarantee requires a trusted owner-controlled local directory and
filesystem with working OS locks. Do not replace the database or lock directory while an
owner runs, or expose the database through file-only bind mounts. Final-file
symlinks and hardlinks, custom SQLite VFS and unsupported URI options are refused.
The lease does not fence older binaries, raw in-process or external SQLite
writers, detached raw connections, or different copies of the database. The
Bitwarden import and `sync rebind-legacy` CLI commands also open the Host
database outside this lease. Their current operations write other tables and
can run normal migrations; stop them before attestation and review any change
that could make them write trust history or profiles. An observed source event
supersedes an older pending candidate, but network delivery and scheduling are
not instantaneous.

The reservation covers the generation manager's trust namespace. The separate
trusted-ingress originating-client PEM bundle is built outside that manager and
is labeled `originating-clients`; it is not checked against source history.
Its forwarded evidence remains a distinct trusted-ingress assertion. Current
certificate-bound token checks and enrollment rate budgets use the originating
certificate's thumbprint, while service binding uses the directly authenticated
ingress. Review any future consumer that relies on the originating profile name;
the label alone does not prove source ownership.

Continuous store identity is an assumption. Restoring an older backup,
switching to another initialized database, deleting and recreating the row, or
altering it outside this protocol can lose history without detection. A move or
restore requires a separately reviewed complete-union migration or an
independent identity and rollback witness; this prototype supplies neither.
The initializer can create a new row after deletion only with a new explicit
attestation, and cannot detect identical deletion and recreation.

Writes require a persistent SQLite journal and `synchronous` of at least FULL
on the checked connection. Their physical durability still depends on SQLite,
the driver and filesystem honoring their contracts; the tests do not prove
power-loss behavior. A process restart also assumes its previous process and
database work have ended. The formal model and its limits are described in the
[source-trust history specification](../../spec/formal/source-trust-history/README.md).
