#!/usr/bin/env python3
"""Reject unreviewed source, build-script, or dependency changes before Cargo."""
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[3]
# Independent input inventory for the CLI-root source-history proof.
MANIFESTS = [
    'apps/cli/Cargo.toml',
    'crates/a2h/Cargo.toml',
    'crates/agent-events/Cargo.toml',
    'crates/agent-hooks/Cargo.toml',
    'crates/audit/Cargo.toml',
    'crates/authenticator-core/Cargo.toml',
    'crates/authn/Cargo.toml',
    'crates/authz/Cargo.toml',
    'crates/bitwarden-server/Cargo.toml',
    'crates/breach-intel/Cargo.toml',
    'crates/broker/Cargo.toml',
    'crates/ceremony/Cargo.toml',
    'crates/claims/Cargo.toml',
    'crates/cli-app-integration/Cargo.toml',
    'crates/client-core/Cargo.toml',
    'crates/connection-broker/Cargo.toml',
    'crates/connection-detect/Cargo.toml',
    'crates/connector-host/Cargo.toml',
    'crates/core/Cargo.toml',
    'crates/credential-helpers/Cargo.toml',
    'crates/daemon/Cargo.toml',
    'crates/domain/Cargo.toml',
    'crates/enforcement/Cargo.toml',
    'crates/env-spec/Cargo.toml',
    'crates/event-seal/Cargo.toml',
    'crates/gateway/Cargo.toml',
    'crates/host-core/Cargo.toml',
    'crates/human-vault/Cargo.toml',
    'crates/ingress-evidence/Cargo.toml',
    'crates/invoke-through/Cargo.toml',
    'crates/kdbx-bridge/Cargo.toml',
    'crates/lifecycle/Cargo.toml',
    'crates/nats-callout/Cargo.toml',
    'crates/pki-core/Cargo.toml',
    'crates/plugin-settings/Cargo.toml',
    'crates/pm-bridges/Cargo.toml',
    'crates/proof/Cargo.toml',
    'crates/protocol-aauth/Cargo.toml',
    'crates/provider-bitwarden/Cargo.toml',
    'crates/provider-openbao/Cargo.toml',
    'crates/provider-openfga/Cargo.toml',
    'crates/quorum-recovery/Cargo.toml',
    'crates/redaction/Cargo.toml',
    'crates/relay/Cargo.toml',
    'crates/rotation-web/Cargo.toml',
    'crates/rotation/Cargo.toml',
    'crates/sealed-log/Cargo.toml',
    'crates/sealed-store/Cargo.toml',
    'crates/security-events/Cargo.toml',
    'crates/session-observe/Cargo.toml',
    'crates/spiffe-source/Cargo.toml',
    'crates/sql/Cargo.toml',
    'crates/storage/Cargo.toml',
    'crates/tailnet-admin/Cargo.toml',
    'crates/tailscale-authn/Cargo.toml',
    'crates/task-access/Cargo.toml',
    'crates/task-bus/Cargo.toml',
    'crates/transport-security/Cargo.toml',
    'crates/trusted-exec/Cargo.toml',
    'crates/uds-authn/Cargo.toml',
    'crates/vault-item-types/Cargo.toml',
    'crates/worker/Cargo.toml',
    'crates/xkeys/Cargo.toml',
    'crates/time/Cargo.toml',
    'patches/vendor/sqlx-sqlite-0.9.0/Cargo.toml',
    'patches/vendor/keepass-0.17.0/Cargo.toml',
]
MIGRATIONS = [
    'crates/storage/migrations/0001_init.sql', 'crates/storage/migrations/0002_connections.sql',
    'crates/storage/migrations/0003_connection_owner.sql', 'crates/storage/migrations/0004_integrations.sql',
    'crates/storage/migrations/0005_credential_generation.sql', 'crates/storage/migrations/0006_provider_configuration.sql',
    'crates/storage/migrations/0007_provider_connections.sql', 'crates/storage/migrations/0008_backup_outbox.sql',
    'crates/storage/migrations/0009_host_kv.sql', 'crates/storage/migrations/0010_connection_materialization.sql',
    'crates/storage/migrations/0011_attachment_targets.sql', 'crates/storage/migrations/0012_connection_delegations.sql',
    'crates/storage/migrations/0013_certificate_issuance.sql', 'crates/storage/migrations/0014_custom_providers.sql',
    'crates/storage/migrations/0015_backup_target_kinds.sql', 'crates/storage/migrations/0016_certificate_manager.sql',
    'crates/storage/migrations/0017_lifecycle_hooks.sql', 'crates/storage/migrations/0018_rotation_leases.sql',
    'crates/storage/migrations/0019_shared_sessions.sql', 'crates/storage/migrations/0020_security_events.sql',
    'crates/storage/migrations/0021_web_login_observation.sql', 'crates/storage/migrations/0022_rotation_policy_owner.sql',
    'crates/storage/migrations/0023_a2h_delivery_and_web_login_watermarks.sql', 'crates/storage/migrations/0024_session_grant_watermarks.sql',
    'crates/storage/migrations/0025_runner_steps.sql', 'crates/storage/migrations/0026_browser_pairing.sql',
    'crates/storage/migrations/0027_a2h_reply_claims.sql', 'crates/storage/migrations/0028_sync_organization_scope.sql',
    'crates/storage/migrations/0029_callback_replay.sql', 'crates/storage/migrations/0030_agent_capabilities.sql',
    'crates/storage/migrations/0031_host_authorizations.sql', 'crates/storage/migrations/0032_config_authorization.sql',
    'crates/storage/migrations/0033_authority_invalidation_fence.sql', 'crates/storage/migrations/0034_general_authority.sql',
    'crates/storage/migrations/0035_session_coordination.sql', 'crates/storage/migrations/0036_authority_grant_watermarks.sql',
    'crates/storage/migrations/0037_session_join_refusal_grant_check.sql', 'crates/storage/migrations/0038_authority_offer_roster_digest.sql',
    'crates/storage/migrations/0039_authority_offer_live_writer.sql', 'crates/storage/migrations/0040_connection_transport.sql',
    'crates/storage/migrations/0041_session_admission.sql', 'crates/storage/migrations/0042_bitwarden_compat.sql',
    'crates/storage/migrations/0043_bitwarden_second_factors.sql', 'crates/storage/migrations/0044_bitwarden_files.sql',
    'crates/storage/migrations/0045_bitwarden_organizations.sql', 'crates/storage/migrations/0046_bitwarden_emergency_access.sql',
    'crates/storage/migrations/0047_bitwarden_auth_requests.sql', 'crates/storage/migrations/0048_bitwarden_org_policies.sql',
    'crates/storage/migrations/0049_agent_hook_policies.sql', 'crates/storage/migrations/0050_web_login_runs.sql',
    'crates/storage/migrations/0051_bitwarden_auth_request_expiry.sql', 'crates/storage/migrations/0052_agent_hook_decisions.sql',
    'crates/storage/migrations/0053_agent_hook_records_run_fk.sql', 'crates/storage/migrations/0054_web_login_recipe_signing.sql',
    'crates/storage/migrations/0055_agent_hook_approvers.sql', 'crates/storage/migrations/0056_outbox_customer_binding.sql',
    'crates/storage/migrations/0057_est_passphrase_budget.sql', 'crates/storage/migrations/0058_bitwarden_attempt_budgets.sql',
    'crates/storage/migrations/0059_est_source_budgets.sql',
]
PATHS = [
    'apps/cli/src/main.rs',
    'apps/cli/src/entry_dispatch.rs',
    'apps/cli/src/entry.rs',
    'apps/cli/src/log_sink.rs',
    'apps/cli/src/session.rs',
    'apps/cli/src/serve.rs',
    'crates/domain/src/lib.rs',
    'crates/domain/src/transport/mod.rs',
    'crates/domain/src/transport/policy.rs',
    'crates/domain/src/transport/selector.rs',
    'crates/domain/src/transport/error.rs',
    'crates/transport-security/src/lib.rs',
    'crates/transport-security/src/generations.rs',
    'crates/transport-security/src/source_lifetime.rs',
    'crates/transport-security/src/source_trust.rs',
    'crates/transport-security/src/source_history_activation.rs',
    'crates/transport-security/src/trust.rs',
    'crates/transport-security/src/error.rs',
    'crates/transport-security/src/env.rs',
    'crates/transport-security/src/identity.rs',
    'crates/transport-security/src/leaf.rs',
    'crates/transport-security/src/svid_profile.rs',
    'crates/spiffe-source/src/lib.rs',
    'crates/spiffe-source/src/source.rs',
    'crates/spiffe-source/src/source_history_flow.rs',
    'crates/spiffe-source/src/source_handle.rs',
    'crates/spiffe-source/src/source_policy.rs',
    'crates/spiffe-source/src/svid_profile.rs',
    'crates/spiffe-source/src/error.rs',
    'crates/spiffe-source/src/config.rs',
    'crates/spiffe-source/src/outage.rs',
    'crates/spiffe-source/src/status.rs',
    'crates/spiffe-source/src/snapshot.rs',
    'crates/spiffe-source/src/bundles.rs',
    'crates/spiffe-source/src/sink.rs',
    'crates/spiffe-source/src/sink/transport.rs',
    'crates/storage/src/lib.rs',
    'crates/storage/src/migrations.rs',
    'crates/storage/src/host_kv.rs',
    'crates/human-vault/src/lib.rs',
    'crates/human-vault/src/root_protection/mod.rs',
    'crates/human-vault/src/root_protection/physical_writer_lease.rs',
    'crates/human-vault/src/unix_private_files.rs',
    'crates/human-vault/src/unix_private_files/writer_lease.rs',
    'crates/gateway/src/lib.rs',
    'crates/gateway/src/app_state.rs',
    'crates/gateway/src/config.rs',
    'crates/gateway/src/transport/mod.rs',
    'crates/gateway/src/transport/config.rs',
    'crates/gateway/src/transport/managed.rs',
    'crates/gateway/src/transport/bindings.rs',
    'crates/gateway/src/transport/boot.rs',
    'crates/gateway/src/transport/runtime.rs',
    'crates/gateway/src/transport/source_history.rs',
    'crates/gateway/src/transport/source_history/coordinator.rs',
    'crates/gateway/src/transport/source_history/file_lock.rs',
    'crates/gateway/src/transport_lifecycle/mod.rs',
    'crates/gateway/src/transport_lifecycle/boot.rs',
    'crates/gateway/src/transport_lifecycle/routes.rs',
    'crates/gateway/src/transport_lifecycle/trust.rs',
    'crates/gateway/src/transport_lifecycle/trust_store.rs',
    'crates/gateway/src/transport_lifecycle/trust_activate.rs',
    'crates/gateway/src/transport/test_support.rs',
    'crates/gateway/src/transport/source_history/tests.rs',
    'crates/gateway/src/transport/source_history/coordinator_tests.rs',
    'crates/gateway/src/transport/source_history/integration_tests.rs',
    'crates/gateway/src/transport_lifecycle/trust_history_tests.rs',
    'crates/gateway/src/transport_lifecycle/trust_generation_tests.rs',
    'crates/gateway/src/transport_lifecycle/routes_tests.rs',
    'crates/gateway/src/transport_lifecycle/test_support.rs',
    'crates/spiffe-source/src/sink/recording.rs',
    'crates/spiffe-source/src/fake/mod.rs',
    'crates/spiffe-source/src/fake/issuer.rs',
    'crates/spiffe-source/src/fake/pb.rs',
    'crates/spiffe-source/src/fake/server.rs',
    'crates/spiffe-source/tests/durable_history_policy.rs',
    'crates/spiffe-source/tests/durable_history_supersession.rs',
    'crates/spiffe-source/tests/support/policy.rs',
    'crates/transport-security/tests/source_history_reservation.rs',
    'crates/transport-security/tests/common/mod.rs',
    'crates/transport-security/src/testkit/mod.rs',
    'crates/transport-security/src/testkit/ca.rs',
    'crates/transport-security/src/testkit/leaf.rs',
    'apps/cli/tests/entry_startup.rs',
    'apps/cli/tests/host_startup_security.rs',
    'scripts/security/cargo-lock-projection.py',
    'scripts/security/cargo-workspace-projection.py',
    'scripts/security/cargo-workspace-multipackage.py',
    'scripts/security/formal-cargo-isolation.py',
    'scripts/security/formal-cargo-freshness.py',
    'scripts/security/formal-proof-source-history.mjs',
    'scripts/security/test_formal_cargo_freshness.py',
    'spec/formal/source-trust-history/SourceTrustHistory.lean',
    'spec/formal/source-trust-history/required-theorems.lean',
    'spec/formal/source-trust-history/lean-toolchain',
    'spec/formal/source-trust-history/verify.sh',
    'spec/formal/source-trust-history/negative-controls.py',
    'spec/formal/required-theorem-command.lean',
    'spec/formal/check-axioms.sh',
]
PATHS.extend(MIGRATIONS)
PATHS.extend(path for path in MANIFESTS if path not in PATHS)
BUILD_PATHS = [str(Path(path).with_name("build.rs")) for path in MANIFESTS]
OPTIONAL_PATHS = ["apps/Cargo.toml", "crates/Cargo.toml", *BUILD_PATHS, ".cargo/config", ".cargo/config.toml"]
# A changed crate root could shadow include_str or redirect the module. Update
# this trusted pin only with a separate review of migration name resolution.
MIGRATION_ROOT_SHA256 = "98e0b2b10bb691e03068f0cb5b1a4f6f71674d3676cd6f7c1b08dacc95196856"
CARGO_TARGETS = {
    'apps/cli/Cargo.toml': {'package': 'opensesame-cli',
        'bin': {'opensesame': 'src/main.rs'},
        'test': {'host_startup_security': 'tests/host_startup_security.rs'}},
    'crates/domain/Cargo.toml': {'package': 'opensesame-domain', 'lib': ('opensesame_domain', 'src/lib.rs')},
    'crates/storage/Cargo.toml': {'package': 'opensesame-storage', 'lib': ('opensesame_storage', 'src/lib.rs')},
    'crates/human-vault/Cargo.toml': {'package': 'opensesame-human-vault', 'lib': ('opensesame_human_vault', 'src/lib.rs')},
    'crates/gateway/Cargo.toml': {'package': 'opensesame-gateway', 'lib': ('opensesame_gateway', 'src/lib.rs')},
    'crates/spiffe-source/Cargo.toml': {'package': 'opensesame-spiffe-source',
        'lib': ('opensesame_spiffe_source', 'src/lib.rs'),
        'test': {'durable_history_policy': 'tests/durable_history_policy.rs',
                 'durable_history_supersession': 'tests/durable_history_supersession.rs'}},
    'crates/transport-security/Cargo.toml': {'package': 'opensesame-transport-security',
        'lib': ('opensesame_transport_security', 'src/lib.rs'),
        'test': {'source_history_reservation': 'tests/source_history_reservation.rs'}},
}


def regular_path(name, optional=False):
    if not isinstance(name, str) or not name:
        raise ValueError("invalid covered path")
    path = Path(name)
    if path.is_absolute() or str(path) != name or any(part in (".", "..") for part in path.parts):
        raise ValueError(f"invalid covered path: {name}")
    current = ROOT
    for index, part in enumerate(path.parts):
        current = current / part
        last = index == len(path.parts) - 1
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError as exc:
            if optional:
                return None
            raise ValueError(f"missing covered path: {name}") from exc
        if not (stat.S_ISREG(mode) if last else stat.S_ISDIR(mode)):
            raise ValueError(f"covered path is not a regular file or directory: {name}")
    return current


def file_hash(name, optional=False):
    path = regular_path(name, optional=optional)
    return None if path is None else hashlib.sha256(path.read_bytes()).hexdigest()


def migration_inventory(source):
    # Consume the entire reviewed module, not merely recognized includes.
    # Anything beyond this small literal grammar requires a separate review.
    head = re.match(
        r'\A(?:[ \t]*///[^\r\n]*\r?\n)*\s*pub\s*\(\s*super\s*\)\s+'
        r'const\s+MIGRATIONS\s*:\s*&\s*\[\s*\(\s*&\s*str\s*,\s*&\s*str\s*\)'
        r'\s*\]\s*=\s*&\s*\[', source,
    )
    if head is None:
        raise ValueError("unsupported Host migration module")
    end = re.compile(r'\s*\]\s*;\s*\Z')
    entry = re.compile(
        r'\s*\(\s*"([0-9]{4}_[a-z0-9_]+)"\s*,\s*include_str!\s*\('
        r'\s*"\.\./migrations/([0-9]{4}_[a-z0-9_]+\.sql)"\s*\)\s*,?\s*\)\s*,'
    )
    position = head.end()
    inventory = []
    while end.fullmatch(source, position) is None:
        item = entry.match(source, position)
        if item is None or item.group(1) + ".sql" != item.group(2):
            raise ValueError("unsupported Host migration module")
        inventory.append("crates/storage/migrations/" + item.group(2))
        position = item.end()
    return inventory


def load_verified(name, path, source):
    # Execute exactly the bytes whose hash was checked; never import cached pyc.
    module = types.ModuleType(name)
    module.__file__ = str(ROOT / path)
    sys.modules[name] = module
    exec(compile(source, module.__file__, "exec", dont_inherit=True), module.__dict__)
    return module


def main():
    try:
        coverage = json.loads(regular_path("spec/formal/source-trust-history/coverage.json").read_text())
        entries = coverage["sources"]
        if (coverage.get("version") != 1 or
                not re.fullmatch(r"[0-9a-f]{40}", str(coverage.get("reviewed_revision", ""))) or
                [entry.get("path") for entry in entries] != PATHS):
            raise ValueError("invalid reviewed source manifest")
        verified = {}
        for entry in entries:
            source = regular_path(entry["path"]).read_bytes()
            if hashlib.sha256(source).hexdigest() != entry["sha256"]:
                raise ValueError(f"review source drift: {entry['path']}")
            verified[entry["path"]] = source
        optional = coverage["optional_sources"]
        if ([entry.get("path") for entry in optional] != OPTIONAL_PATHS or
                any(file_hash(entry["path"], optional=True) != entry["sha256"] for entry in optional)):
            raise ValueError("review optional source/build configuration drift")
        if any(file_hash(path, optional=True) is not None for path in BUILD_PATHS):
            raise ValueError("local build script requires separately reviewed coverage")
        if hashlib.sha256(verified["crates/storage/src/lib.rs"]).hexdigest() != MIGRATION_ROOT_SHA256:
            raise ValueError("reviewed storage migration root changed")
        migration_source = regular_path("crates/storage/src/migrations.rs").read_text()
        if migration_inventory(migration_source) != MIGRATIONS:
            raise ValueError("reviewed Host migration inventory changed")
        # Load the exact verified bytes in a new private directory. This also
        # isolates nested helper imports from ignored stale/forged __pycache__.
        helpers = [
            "scripts/security/cargo-lock-projection.py",
            "scripts/security/cargo-workspace-projection.py",
            "scripts/security/cargo-workspace-multipackage.py",
            "scripts/security/formal-cargo-isolation.py",
        ]
        with tempfile.TemporaryDirectory(prefix="opensesame-history-helpers-") as directory:
            isolated = Path(directory)
            for name in helpers:
                (isolated / Path(name).name).write_bytes(verified[name])
            sys.dont_write_bytecode = True
            isolation = load_verified("history_cargo_isolation", isolated / Path(helpers[3]).name, verified[helpers[3]])
            isolation.check_cargo_targets(ROOT, CARGO_TARGETS, set(verified))
            projection = load_verified("cargo_lock_projection", isolated / Path(helpers[0]).name, verified[helpers[0]])
            recorded = coverage["lock_projection"]
            if (recorded.get("root") != "opensesame-cli" or
                    recorded.get("algorithm") != "cargo-lock-projection-v1-sha256"):
                raise ValueError("invalid reviewed dependency projection")
            graph = projection.read_lock(regular_path("Cargo.lock"))
            if projection.projection_sha256(graph, recorded["root"]) != recorded["sha256"]:
                raise ValueError("review CLI dependency graph drift")
            multi = load_verified("cargo_workspace_multipackage", isolated / Path(helpers[2]).name, verified[helpers[2]])
            documents = {path: multi.workspace_projection.read_toml(regular_path(path)) for path in MANIFESTS}
            for name in multi.manifest_ancestors(documents):
                if name in documents:
                    continue
                ancestor = regular_path(name, optional=True)
                documents[name] = None if ancestor is None else multi.workspace_projection.read_toml(ancestor)
            workspace = multi.workspace_projection.read_toml(regular_path("Cargo.toml"))
            projected = multi.project(workspace, documents, graph, "opensesame-cli", "apps/cli/Cargo.toml")
            expected_workspace = {
                "root": "opensesame-cli",
                "package": "apps/cli/Cargo.toml",
                "algorithm": "cargo-workspace-projection-v1-sha256",
                "sha256": multi.workspace_projection.digest(projected),
            }
            if coverage.get("workspace_projection") != expected_workspace:
                raise ValueError("review CLI workspace inputs drift")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"source-trust-history-formal: {exc}") from exc
    print(f"source-trust-history-formal: reviewed sources and dependencies match base {coverage['reviewed_revision']}")


if __name__ == "__main__":
    main()
