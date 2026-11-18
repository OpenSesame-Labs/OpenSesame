#!/usr/bin/env python3
"""Reject unreviewed source, build-script, or dependency changes before Cargo."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[3]
TARGETS = {
    "crates/domain/Cargo.toml": {"package": "opensesame-domain", "lib": ("opensesame_domain", "src/lib.rs")},
    "crates/transport-security/Cargo.toml": {"package": "opensesame-transport-security", "lib": ("opensesame_transport_security", "src/lib.rs")},
    "crates/spiffe-source/Cargo.toml": {"package": "opensesame-spiffe-source", "lib": ("opensesame_spiffe_source", "src/lib.rs")},
    "crates/storage/Cargo.toml": {"package": "opensesame-storage", "lib": ("opensesame_storage", "src/lib.rs")},
    "crates/gateway/Cargo.toml": {"package": "opensesame-gateway", "lib": ("opensesame_gateway", "src/lib.rs")},
}
# Reviewed local package closure for the gateway proof target.
MANIFESTS = [
    "crates/a2h/Cargo.toml",
    "crates/agent-events/Cargo.toml",
    "crates/agent-hooks/Cargo.toml",
    "crates/audit/Cargo.toml",
    "crates/authenticator-core/Cargo.toml",
    "crates/authn/Cargo.toml",
    "crates/authz/Cargo.toml",
    "crates/bitwarden-server/Cargo.toml",
    "crates/breach-intel/Cargo.toml",
    "crates/broker/Cargo.toml",
    "crates/ceremony/Cargo.toml",
    "crates/claims/Cargo.toml",
    "crates/cli-app-integration/Cargo.toml",
    "crates/client-core/Cargo.toml",
    "crates/connection-broker/Cargo.toml",
    "crates/connection-detect/Cargo.toml",
    "crates/connector-host/Cargo.toml",
    "crates/core/Cargo.toml",
    "crates/domain/Cargo.toml",
    "crates/enforcement/Cargo.toml",
    "crates/env-spec/Cargo.toml",
    "crates/event-seal/Cargo.toml",
    "crates/gateway/Cargo.toml",
    "crates/host-core/Cargo.toml",
    "crates/human-vault/Cargo.toml",
    "crates/ingress-evidence/Cargo.toml",
    "crates/invoke-through/Cargo.toml",
    "crates/lifecycle/Cargo.toml",
    "crates/nats-callout/Cargo.toml",
    "crates/pki-core/Cargo.toml",
    "crates/plugin-settings/Cargo.toml",
    "crates/proof/Cargo.toml",
    "crates/protocol-aauth/Cargo.toml",
    "crates/provider-bitwarden/Cargo.toml",
    "crates/provider-openbao/Cargo.toml",
    "crates/provider-openfga/Cargo.toml",
    "crates/redaction/Cargo.toml",
    "crates/relay/Cargo.toml",
    "crates/rotation-web/Cargo.toml",
    "crates/rotation/Cargo.toml",
    "crates/sealed-store/Cargo.toml",
    "crates/security-events/Cargo.toml",
    "crates/session-observe/Cargo.toml",
    "crates/spiffe-source/Cargo.toml",
    "crates/sql/Cargo.toml",
    "crates/storage/Cargo.toml",
    "crates/task-access/Cargo.toml",
    "crates/task-bus/Cargo.toml",
    "crates/transport-security/Cargo.toml",
    "crates/trusted-exec/Cargo.toml",
    "crates/xkeys/Cargo.toml",
]
PATHS = [
    "crates/domain/Cargo.toml",
    "crates/domain/src/lib.rs",
    "crates/domain/src/transport/mod.rs",
    "crates/domain/src/transport/policy.rs",
    "crates/domain/src/transport/selector.rs",
    "crates/domain/src/transport/evidence.rs",
    "crates/domain/src/transport/attest.rs",
    "crates/domain/src/transport/error.rs",
    "crates/transport-security/Cargo.toml",
    "crates/transport-security/src/lib.rs",
    "crates/transport-security/src/generations.rs",
    "crates/transport-security/src/source_lifetime.rs",
    "crates/transport-security/src/source_trust.rs",
    "crates/transport-security/src/provenance.rs",
    "crates/transport-security/src/svid_profile.rs",
    "crates/transport-security/src/svid_tls.rs",
    "crates/transport-security/src/trust.rs",
    "crates/transport-security/src/identity.rs",
    "crates/transport-security/src/leaf.rs",
    "crates/transport-security/src/client.rs",
    "crates/transport-security/src/server.rs",
    "crates/transport-security/src/signing_fence.rs",
    "crates/transport-security/src/bounded.rs",
    "crates/transport-security/src/error.rs",
    "crates/transport-security/src/env.rs",
    "crates/transport-security/src/listener.rs",
    "crates/transport-security/src/server_conn.rs",
    "crates/transport-security/src/guard.rs",
    "crates/transport-security/src/testkit/mod.rs",
    "crates/transport-security/src/testkit/ca.rs",
    "crates/transport-security/src/testkit/leaf.rs",
    "crates/spiffe-source/Cargo.toml",
    "crates/spiffe-source/src/lib.rs",
    "crates/spiffe-source/src/source_policy.rs",
    "crates/spiffe-source/src/bundles.rs",
    "crates/spiffe-source/src/outage.rs",
    "crates/spiffe-source/src/status.rs",
    "crates/spiffe-source/src/snapshot.rs",
    "crates/spiffe-source/src/error.rs",
    "crates/spiffe-source/src/config.rs",
    "crates/spiffe-source/src/source.rs",
    "crates/spiffe-source/src/source_handle.rs",
    "crates/spiffe-source/src/sink.rs",
    "crates/spiffe-source/src/sink/transport.rs",
    "crates/spiffe-source/src/svid_profile.rs",
    "crates/storage/Cargo.toml",
    "crates/storage/src/lib.rs",
    "crates/storage/src/host_kv.rs",
    "crates/gateway/Cargo.toml",
    "crates/gateway/src/lib.rs",
    "crates/gateway/src/app_state.rs",
    "crates/gateway/src/transport/mod.rs",
    "crates/gateway/src/transport/boot.rs",
    "crates/gateway/src/transport/source_trust_selection.rs",
    "crates/gateway/src/transport/config.rs",
    "crates/gateway/src/transport/runtime.rs",
    "crates/gateway/src/transport/test_support.rs",
    "crates/gateway/src/transport/boot_source_trust_tests.rs",
    "crates/gateway/src/transport/source_trust_selection_formal.rs",
    "crates/gateway/src/transport_lifecycle/mod.rs",
    "crates/gateway/src/transport_lifecycle/boot.rs",
    "crates/gateway/src/transport_lifecycle/trust.rs",
    "crates/gateway/src/transport_lifecycle/trust_store.rs",
    "crates/gateway/src/transport_lifecycle/trust_activate.rs",
    "crates/gateway/src/transport_lifecycle/activation.rs",
    "crates/gateway/src/transport_lifecycle/test_support.rs",
    "scripts/security/cargo-lock-projection.py",
    "scripts/security/cargo-workspace-projection.py",
    "scripts/security/cargo-workspace-multipackage.py",
    "scripts/security/formal-cargo-isolation.py",
    "scripts/security/formal-cargo-freshness.py",
]
PATHS.extend(path for path in MANIFESTS if path not in PATHS)
BUILD_PATHS = [str(Path(path).with_name("build.rs")) for path in MANIFESTS]
OPTIONAL_PATHS = ["crates/Cargo.toml", *BUILD_PATHS, ".cargo/config", ".cargo/config.toml"]
NATS_MANIFESTS = [
    "crates/domain/Cargo.toml",
    "crates/task-bus/Cargo.toml",
    "crates/transport-security/Cargo.toml",
    "crates/xkeys/Cargo.toml",
]
NATS_TARGETS = {
    "crates/domain/Cargo.toml": {"package": "opensesame-domain", "lib": ("opensesame_domain", "src/lib.rs")},
    "crates/task-bus/Cargo.toml": {"package": "opensesame-task-bus", "lib": ("opensesame_task_bus", "src/lib.rs")},
    "crates/transport-security/Cargo.toml": {"package": "opensesame-transport-security", "lib": ("opensesame_transport_security", "src/lib.rs")},
    "crates/xkeys/Cargo.toml": {"package": "opensesame-xkeys", "lib": ("opensesame_xkeys", "src/lib.rs")},
}
NATS_LIB_TESTS = [
    ("nats::live_mixed::lean_vectors_match_nats_injection", "correspondence", True, "crates/task-bus/src/nats_live_mixed.rs"),
    ("nats::live_roles::injected_kind_and_identity_must_match_configured_policy", "identity", False, "crates/task-bus/src/nats_live_roles.rs"),
    ("nats::live_tests::injected_spiffe_client_matches_locator_and_profile", "client_svid", True, "crates/task-bus/src/nats_live_tests.rs"),
    ("nats::tests::security_bearing_env_settings_never_select_plaintext", "env", False, "crates/task-bus/src/nats_tests.rs"),
    ("nats_transport_env::tests::nonassertive_env_cannot_override_stored_tls", "nonassertive", False, "crates/task-bus/src/nats_transport_env.rs"),
    ("validate::tests::invalid_nats_security_booleans_fail_closed", "flags", False, "crates/task-bus/src/validate.rs"),
    ("validate::tests::lean_vectors_match_nats_reconnect_limit", "retry_limit", True, "crates/task-bus/src/validate.rs"),
    ("tests::contradictory_nats_security_sources_are_refused", "conflicts", False, "crates/task-bus/src/lib_tests.rs"),
    ("tests::mutated_public_policy_cannot_ignore_security_locators", "locators", False, "crates/task-bus/src/lib_tests.rs"),
    ("tests::stored_tls_requirements_cannot_resolve_to_plaintext", "stored", False, "crates/task-bus/src/lib_tests.rs"),
    ("tests::failed_and_old_connections_cannot_change_active_health", "health", False, "crates/task-bus/src/lib_tests.rs"),
    ("nats::rotation::tests::pending_old_session_drain_cannot_block_rotation", "drain", False, "crates/task-bus/src/nats_rotation.rs"),
    ("nats::live_delivery::accepted_material_and_view_follow_serialized_rotations", "rotation", True, "crates/task-bus/src/nats_live_delivery.rs"),
    ("nats::live_topology::injected_trust_enforces_configured_crls", "crls", True, "crates/task-bus/src/nats_live_topology.rs"),
    ("nats::live_routes::injected_sessions_fence_reconnect_and_rotation", "reconnect", True, "crates/task-bus/src/nats_live_routes.rs"),
]
NATS_PATHS = [
    *NATS_MANIFESTS,
    "crates/domain/src/lib.rs",
    "crates/domain/src/transport/mod.rs",
    "crates/domain/src/transport/policy.rs",
    "crates/domain/src/transport/selector.rs",
    "crates/domain/src/transport/error.rs",
    "crates/task-bus/src/lib.rs",
    "crates/task-bus/src/nats.rs",
    "crates/task-bus/src/nats_connect.rs",
    "crates/task-bus/src/nats_delivery.rs",
    "crates/task-bus/src/nats_policy.rs",
    "crates/task-bus/src/nats_rotation.rs",
    "crates/task-bus/src/nats_transport.rs",
    "crates/task-bus/src/nats_transport_env.rs",
    "crates/task-bus/src/validate.rs",
    "crates/task-bus/src/lib_tests.rs",
    "crates/task-bus/src/nats_tests.rs",
    "crates/task-bus/src/nats_live_delivery.rs",
    "crates/task-bus/src/nats_live_harness.rs",
    "crates/task-bus/src/nats_live_mixed.rs",
    "crates/task-bus/src/nats_live_roles.rs",
    "crates/task-bus/src/nats_live_routes.rs",
    "crates/task-bus/src/nats_live_callout.rs",
    "crates/task-bus/src/nats_live_tests.rs",
    "crates/task-bus/src/nats_live_topology.rs",
    "crates/transport-security/src/lib.rs",
    "crates/transport-security/src/client.rs",
    "crates/transport-security/src/trust.rs",
    "crates/transport-security/src/verify_spiffe.rs",
    "crates/transport-security/src/svid_tls.rs",
    "crates/transport-security/src/svid_profile.rs",
    "crates/transport-security/src/bounded.rs",
    "crates/transport-security/src/identity.rs",
    "crates/transport-security/src/leaf.rs",
    "crates/transport-security/src/error.rs",
    "crates/transport-security/src/env.rs",
    "crates/transport-security/src/testkit/mod.rs",
    "crates/transport-security/src/testkit/ca.rs",
    "crates/transport-security/src/testkit/leaf.rs",
    "crates/xkeys/src/lib.rs",
    "rust-toolchain.toml",
    "ops/nats/local-dev.conf",
    "scripts/mtls/mtls-fixtures.sh",
    "scripts/security/cargo-lock-projection.py",
    "scripts/security/cargo-workspace-projection.py",
    "scripts/security/cargo-workspace-multipackage.py",
    "scripts/security/formal-cargo-isolation.py",
    "scripts/security/formal-cargo-freshness.py",
    "spec/formal/source-trust-selection/test_drift.py",
]
NATS_BUILD_PATHS = [str(Path(path).with_name("build.rs")) for path in NATS_MANIFESTS]
NATS_OPTIONAL_PATHS = ["crates/Cargo.toml", *NATS_BUILD_PATHS, ".cargo/config", ".cargo/config.toml"]


def check_nats_test_inventory():
    source = regular_path("spec/formal/source-trust-selection/verify.sh").read_text()
    pattern = r"^[ \t]*run_nats_test ([A-Za-z0-9_:]+) ([a-z_]+)( --ignored)?$"
    actual = [(name, label, bool(ignored)) for name, label, ignored in re.findall(pattern, source, re.MULTILINE)]
    expected = [(name, label, ignored) for name, label, ignored, _ in NATS_LIB_TESTS]
    transport = re.findall(r"^[ \t]*run_transport_test ([A-Za-z0-9_:]+) ([a-z_]+)$", source, re.MULTILINE)
    if (actual != expected or transport != [("bounded::tests::single_handshake_gate_consumes_failed_and_concurrent_attempts", "single_handshake")]
            or "crates/transport-security/src/bounded.rs" not in NATS_PATHS
            or any(path not in NATS_PATHS for _, _, _, path in NATS_LIB_TESTS)):
        raise ValueError("NATS exact test inventory drift")


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


def load_verified(name, path, source):
    # Execute exactly the bytes whose hash was checked; never import cached pyc.
    module = types.ModuleType(name)
    module.__file__ = str(ROOT / path)
    sys.modules[name] = module
    exec(compile(source, module.__file__, "exec", dont_inherit=True), module.__dict__)
    return module


def main():
    try:
        if sys.argv[1:] not in ([], ["--nats"]):
            raise ValueError("expected no arguments or --nats")
        selected = os.environ.get("OPENSESAME_FORMAL_NATS", "0")
        if selected not in ("0", "1"):
            raise ValueError("invalid OPENSESAME_FORMAL_NATS value")
        nats = sys.argv[1:] == ["--nats"] or selected == "1"
        if nats:
            check_nats_test_inventory()
        coverage = json.loads(regular_path("spec/formal/source-trust-selection/coverage.json").read_text())
        if nats:
            coverage = coverage["nats"]
        paths = NATS_PATHS if nats else PATHS
        manifests = NATS_MANIFESTS if nats else MANIFESTS
        build_paths = NATS_BUILD_PATHS if nats else BUILD_PATHS
        optional_paths = NATS_OPTIONAL_PATHS if nats else OPTIONAL_PATHS
        root = "opensesame-task-bus" if nats else "opensesame-gateway"
        root_manifest = "crates/task-bus/Cargo.toml" if nats else "crates/gateway/Cargo.toml"
        entries = coverage["sources"]
        if (coverage.get("version") != 1 or
                not re.fullmatch(r"[0-9a-f]{40}", str(coverage.get("reviewed_revision", ""))) or
                [entry.get("path") for entry in entries] != paths):
            raise ValueError("invalid reviewed source manifest")
        verified = {}
        for entry in entries:
            source = regular_path(entry["path"]).read_bytes()
            if hashlib.sha256(source).hexdigest() != entry["sha256"]:
                raise ValueError(f"review source drift: {entry['path']}")
            verified[entry["path"]] = source
        optional = coverage["optional_sources"]
        if ([entry.get("path") for entry in optional] != optional_paths or
                any(file_hash(entry["path"], optional=True) != entry["sha256"] for entry in optional)):
            raise ValueError("review optional source/build configuration drift")
        if any(file_hash(path, optional=True) is not None for path in build_paths):
            raise ValueError("local build script requires separately reviewed coverage")
        helper_name = "scripts/security/formal-cargo-isolation.py"
        isolation = load_verified("reviewed_cargo_isolation", helper_name, verified[helper_name])
        isolation.check_cargo_targets(ROOT, NATS_TARGETS if nats else TARGETS, set(verified))
        # Load the exact verified bytes in a new private directory. This also
        # isolates nested helper imports from ignored stale/forged __pycache__.
        helpers = [
            "scripts/security/cargo-lock-projection.py",
            "scripts/security/cargo-workspace-projection.py",
            "scripts/security/cargo-workspace-multipackage.py",
        ]
        with tempfile.TemporaryDirectory(prefix="opensesame-selector-helpers-") as directory:
            isolated = Path(directory)
            for name in helpers:
                (isolated / Path(name).name).write_bytes(verified[name])
            sys.dont_write_bytecode = True
            projection = load_verified("cargo_lock_projection", isolated / Path(helpers[0]).name, verified[helpers[0]])
            recorded = coverage["lock_projection"]
            if (recorded.get("root") != root or
                    recorded.get("algorithm") != "cargo-lock-projection-v1-sha256"):
                raise ValueError("invalid reviewed dependency projection")
            graph = projection.read_lock(regular_path("Cargo.lock"))
            if projection.projection_sha256(graph, recorded["root"]) != recorded["sha256"]:
                raise ValueError("review dependency graph drift")
            multi = load_verified("cargo_workspace_multipackage", isolated / Path(helpers[2]).name, verified[helpers[2]])
            documents = {path: multi.workspace_projection.read_toml(regular_path(path)) for path in manifests}
            ancestor = regular_path("crates/Cargo.toml", optional=True)
            documents["crates/Cargo.toml"] = None if ancestor is None else multi.workspace_projection.read_toml(ancestor)
            workspace = multi.workspace_projection.read_toml(regular_path("Cargo.toml"))
            projected = multi.project(workspace, documents, graph, root, root_manifest)
            expected_workspace = {
                "root": root,
                "package": root_manifest,
                "algorithm": "cargo-workspace-projection-v1-sha256",
                "sha256": multi.workspace_projection.digest(projected),
            }
            if coverage.get("workspace_projection") != expected_workspace:
                raise ValueError("review gateway workspace inputs drift")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"source-trust-selection-formal: {exc}") from exc
    print(f"source-trust-selection-formal: reviewed sources and dependencies match base {coverage['reviewed_revision']}")


if __name__ == "__main__":
    main()
