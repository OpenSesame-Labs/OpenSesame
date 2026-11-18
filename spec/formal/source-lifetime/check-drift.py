#!/usr/bin/env python3
"""Reject unreviewed changes to the source-owned generation boundary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[3]
PATHS = [
    "crates/domain/Cargo.toml",
    "crates/domain/src/lib.rs",
    "crates/domain/src/transport/mod.rs",
    "crates/domain/src/transport/policy.rs",
    "crates/domain/src/transport/evidence.rs",
    "crates/domain/src/transport/attest.rs",
    "crates/domain/src/transport/error.rs",
    "crates/transport-security/Cargo.toml",
    "crates/transport-security/src/generations.rs",
    "crates/transport-security/src/source_lifetime.rs",
    "crates/transport-security/src/source_trust.rs",
    "crates/transport-security/src/provenance.rs",
    "crates/transport-security/src/svid_profile.rs",
    "crates/transport-security/src/guard.rs",
    "crates/transport-security/src/listener.rs",
    "crates/transport-security/src/client.rs",
    "crates/transport-security/src/server.rs",
    "crates/transport-security/src/signing_fence.rs",
    "crates/transport-security/src/server_conn.rs",
    "crates/transport-security/src/trust.rs",
    "crates/transport-security/src/identity.rs",
    "crates/transport-security/src/leaf.rs",
    "crates/transport-security/src/lib.rs",
    "crates/spiffe-source/Cargo.toml",
    "crates/spiffe-source/src/lib.rs",
    "crates/spiffe-source/src/source.rs",
    "crates/spiffe-source/src/source_handle.rs",
    "crates/spiffe-source/src/sink.rs",
    "crates/spiffe-source/src/sink/transport.rs",
    "crates/spiffe-source/src/snapshot.rs",
    "crates/spiffe-source/src/outage.rs",
    "crates/spiffe-source/src/status.rs",
    "crates/spiffe-source/src/source_policy.rs",
    "crates/spiffe-source/src/config.rs",
    "crates/spiffe-source/src/bundles.rs",
    "crates/storage/Cargo.toml",
    "crates/storage/src/lib.rs",
    "crates/storage/src/host_kv.rs",
    "crates/gateway/Cargo.toml",
    "crates/gateway/src/lib.rs",
    "crates/gateway/src/routes/mod.rs",
    "crates/gateway/src/transport/mod.rs",
    "crates/gateway/src/transport_lifecycle/mod.rs",
    "crates/gateway/src/transport/boot.rs",
    "crates/gateway/src/transport/source_trust_selection.rs",
    "crates/gateway/src/transport/runtime.rs",
    "crates/gateway/src/transport/admission.rs",
    "crates/gateway/src/transport/status.rs",
    "crates/gateway/src/routes/est_wire.rs",
    "crates/gateway/src/routes/est_auth.rs",
    "crates/gateway/src/routes/est_server.rs",
    "crates/gateway/src/routes/est_passphrase_budget.rs",
    "crates/gateway/src/routes/est_freshness.rs",
    "crates/gateway/src/transport_lifecycle/trust_activate.rs",
    "crates/gateway/src/transport_lifecycle/trust_store.rs",
    "crates/gateway/src/transport_lifecycle/trust.rs",
    "crates/gateway/src/transport_lifecycle/activation.rs",
    "crates/gateway/src/transport_lifecycle/boot.rs",
    "crates/transport-security/src/source_lifetime_tests.rs",
    "crates/transport-security/src/signing_fence_tests.rs",
    "crates/gateway/src/transport/status_tests.rs",
    "crates/gateway/src/transport/admission_tests.rs",
    "crates/gateway/src/transport/admission_source_tests.rs",
    "crates/gateway/src/routes/est_test_pause.rs",
    "crates/gateway/src/transport_lifecycle/trust_source_tests.rs",
    "crates/gateway/src/transport_lifecycle/trust_generation_tests.rs",
    "crates/gateway/src/routes/est_server_tests.rs",
    "crates/gateway/src/routes/est_certificate_proof_tests.rs",
    "crates/gateway/src/routes/est_certificate_freshness_tests.rs",
    "crates/transport-security/tests/source_lifetime_formal.rs",
    "crates/transport-security/tests/signing_fence_races.rs",
    "crates/transport-security/tests/source_lifetime_tls12.rs",
    "crates/transport-security/tests/source_lifetime.rs",
    "crates/transport-security/tests/source_lifetime_edges.rs",
    "crates/transport-security/tests/common/mod.rs",
    "crates/spiffe-source/src/source_lease_tests.rs",
]
OPTIONAL_PATHS = [
    "crates/domain/build.rs",
    "crates/spiffe-source/build.rs",
    "crates/transport-security/build.rs",
    "crates/gateway/build.rs",
    "crates/storage/build.rs",
]


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
            if optional and last:
                return None
            raise ValueError(f"missing covered path: {name}") from exc
        if not (stat.S_ISREG(mode) if last else stat.S_ISDIR(mode)):
            raise ValueError(f"covered path is not a regular file or directory: {name}")
    return current


def optional_hash(name):
    path = regular_path(name, optional=True)
    return None if path is None else hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    try:
        coverage = json.loads((ROOT / "spec/formal/source-lifetime/coverage.json").read_text())
        entries = coverage["sources"]
        if (coverage.get("version") != 1 or
                not re.fullmatch(r"[0-9a-f]{40}", str(coverage.get("reviewed_revision", ""))) or
                [entry.get("path") for entry in entries] != PATHS):
            raise ValueError("invalid reviewed source manifest")
        for entry in entries:
            if hashlib.sha256(regular_path(entry["path"]).read_bytes()).hexdigest() != entry["sha256"]:
                raise ValueError(f"review source drift: {entry['path']}")
        optional = coverage["optional_sources"]
        if ([entry.get("path") for entry in optional] != OPTIONAL_PATHS or
                any(optional_hash(entry["path"]) != entry["sha256"] for entry in optional)):
            raise ValueError("review optional source/build-script drift")
        helper = regular_path("scripts/security/cargo-lock-projection.py")
        spec = importlib.util.spec_from_file_location("cargo_lock_projection", helper)
        if spec is None or spec.loader is None:
            raise ValueError("lock projection helper unavailable")
        projection = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = projection
        exec(compile(helper.read_bytes(), str(helper), "exec", dont_inherit=True), projection.__dict__)
        recorded = coverage["lock_projection"]
        if (recorded.get("root") != "opensesame-spiffe-source" or
                recorded.get("algorithm") != "cargo-lock-projection-v1-sha256"):
            raise ValueError("invalid reviewed dependency projection")
        graph = projection.read_lock(ROOT / "Cargo.lock")
        if projection.projection_sha256(graph, recorded["root"]) != recorded["sha256"]:
            raise ValueError("review source-lifetime dependency graph drift")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"source-lifetime-formal: {exc}") from exc
    print(f"source-lifetime-formal: reviewed sources and dependencies match base {coverage['reviewed_revision']}")


if __name__ == "__main__":
    main()
