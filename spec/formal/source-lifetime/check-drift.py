#!/usr/bin/env python3
"""Reject unreviewed changes to the source-owned generation boundary.

Each covered source records a sha256 of the reviewed bytes and the git blob id
of those bytes (`reviewed_blob`), as the SPIFFE checker does: a coverage edit
cannot point at bytes the repository does not contain. `reviewed_revision`
stays a main ancestor. Its tree is the pre-fix base: `base_blob` is
`git rev-parse revision:path` when the path existed there, and null when it
did not. The reviewed blob is the post-fix evidence, which is what remains
reachable after a squash merge replaces the branch commit.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "security"))
from formal_coverage_drift import assert_reviewed_revision_on_main, lineage_git_root  # noqa: E402
TARGETS = {
    "crates/domain/Cargo.toml": {"package": "opensesame-domain", "lib": ("opensesame_domain", "src/lib.rs")},
    "crates/transport-security/Cargo.toml": {
        "package": "opensesame-transport-security", "lib": ("opensesame_transport_security", "src/lib.rs"),
        "test": {name: f"tests/{name}.rs" for name in (
            "source_lifetime_formal", "signing_fence_races", "source_lifetime_tls12", "source_lifetime", "source_lifetime_edges",
        )},
    },
    "crates/spiffe-source/Cargo.toml": {"package": "opensesame-spiffe-source", "lib": ("opensesame_spiffe_source", "src/lib.rs")},
    "crates/storage/Cargo.toml": {"package": "opensesame-storage", "lib": ("opensesame_storage", "src/lib.rs")},
    "crates/gateway/Cargo.toml": {"package": "opensesame-gateway", "lib": ("opensesame_gateway", "src/lib.rs")},
}
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
    "crates/transport-security/src/source_history_activation.rs",
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
    "crates/spiffe-source/src/source_history_flow.rs",
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
    "scripts/security/formal-cargo-isolation.py",
    "scripts/security/formal-cargo-freshness.py",
    "scripts/security/formal_cargo_packages.py",
    "scripts/security/cargo-lock-projection.py",
    "scripts/security/verify-vendored-sqlx.py",
]
# 2026-11-24: the runner now builds through the freshness session, which
# tracks the declared sqlx-sqlite path patch (reached by opensesame-time's
# default sqlx feature). It is outside this property; its tree is pinned by
# the reviewed vendored-crate verifier, executed on every input check.
VENDORED_VERIFIERS = ("scripts/security/verify-vendored-sqlx.py",)
OPTIONAL_PATHS = [
    "crates/domain/build.rs",
    "crates/spiffe-source/build.rs",
    "crates/transport-security/build.rs",
    "crates/gateway/build.rs",
    "crates/storage/build.rs",
]
BLOB_RE = re.compile(r"[0-9a-f]{40}\Z")
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")


def git(*args: str) -> subprocess.CompletedProcess[bytes]:
    # A scratch negative-control tree has no .git; blobs resolve in its owner.
    return subprocess.run(
        ["git", "-C", str(lineage_git_root(ROOT)), *args],
        capture_output=True,
        env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
        check=False,
    )


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


def blob_bytes(blob: str) -> bytes:
    if not isinstance(blob, str) or BLOB_RE.fullmatch(blob) is None:
        raise ValueError(f"invalid git blob id {blob!r}")
    result = git("cat-file", "blob", blob)
    if result.returncode != 0:
        raise ValueError(f"reviewed blob {blob} is not in this repository")
    return result.stdout


def revision_blob(revision: str, path: str) -> str | None:
    result = git("rev-parse", f"{revision}:{path}")
    if result.returncode != 0:
        return None
    blob = result.stdout.decode().strip()
    if BLOB_RE.fullmatch(blob) is None:
        raise ValueError(f"invalid blob id for {revision}:{path}")
    return blob


def verify_sources(entries: list, revision: str) -> dict[str, bytes]:
    verified = {}
    for item in entries:
        path = item["path"]
        expected = item["sha256"]
        if not isinstance(path, str) or SHA_RE.fullmatch(str(expected)) is None:
            raise ValueError(f"malformed covered source entry for {path!r}")
        if path.startswith("/") or ".." in Path(path).parts:
            raise ValueError(f"covered source path must stay in-repo: {path!r}")
        source = regular_path(path).read_bytes()
        work = hashlib.sha256(source).hexdigest()
        if work != expected:
            raise ValueError(f"review source drift: {path}")
        reviewed = hashlib.sha256(blob_bytes(item["reviewed_blob"])).hexdigest()
        if reviewed != expected:
            raise ValueError(f"reviewed blob does not match hashed bytes: {path}")
        ancestor = revision_blob(revision, path)
        base_blob = item["base_blob"]
        if base_blob is None:
            if ancestor is not None:
                raise ValueError(f"reviewed revision contains {path} but base_blob is null")
        else:
            if ancestor != base_blob:
                raise ValueError(f"reviewed revision blob for {path} does not match base_blob")
            shown = git("show", f"{revision}:{path}")
            if shown.returncode != 0:
                raise ValueError(f"reviewed revision bytes unavailable for {path}")
            if hashlib.sha256(shown.stdout).hexdigest() != hashlib.sha256(blob_bytes(base_blob)).hexdigest():
                raise ValueError(f"reviewed revision bytes do not match base blob: {path}")
        verified[path] = source
    return verified


def main():
    try:
        coverage = json.loads((ROOT / "spec/formal/source-lifetime/coverage.json").read_text())
        entries = coverage["sources"]
        revision = str(coverage.get("reviewed_revision", ""))
        if (coverage.get("version") != 2 or
                not re.fullmatch(r"[0-9a-f]{40}", revision) or
                [entry.get("path") for entry in entries] != PATHS):
            raise ValueError("invalid reviewed source manifest")
        assert_reviewed_revision_on_main(ROOT, revision, "source-lifetime-formal")
        verified = verify_sources(entries, revision)
        optional = coverage["optional_sources"]
        if ([entry.get("path") for entry in optional] != OPTIONAL_PATHS or
                any(optional_hash(entry["path"]) != entry["sha256"] for entry in optional)):
            raise ValueError("review optional source/build-script drift")
        helper_name = "scripts/security/formal-cargo-isolation.py"
        scope = {"__name__": "reviewed_cargo_isolation", "__file__": str(ROOT / helper_name)}
        exec(compile(verified[helper_name], scope["__file__"], "exec", dont_inherit=True), scope)
        scope["check_cargo_targets"](ROOT, TARGETS, set(verified))
        for name in VENDORED_VERIFIERS:
            scope = {"__name__": "reviewed_vendored_crate", "__file__": str(ROOT / name)}
            exec(compile(verified[name], scope["__file__"], "exec", dont_inherit=True), scope)
            scope["verify"](ROOT)
        helper_name = "scripts/security/cargo-lock-projection.py"
        helper = regular_path(helper_name)
        spec = importlib.util.spec_from_file_location("cargo_lock_projection", helper)
        if spec is None or spec.loader is None:
            raise ValueError("lock projection helper unavailable")
        projection = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = projection
        exec(compile(verified[helper_name], str(helper), "exec", dont_inherit=True), projection.__dict__)
        recorded = coverage["lock_projection"]
        if (recorded.get("root") != "opensesame-spiffe-source" or
                recorded.get("algorithm") != "cargo-lock-projection-v1-sha256"):
            raise ValueError("invalid reviewed dependency projection")
        graph = projection.read_lock(ROOT / "Cargo.lock")
        if projection.projection_sha256(graph, recorded["root"]) != recorded["sha256"]:
            raise ValueError("review source-lifetime dependency graph drift")
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        raise SystemExit(f"source-lifetime-formal: {exc}") from exc
    print(f"source-lifetime-formal: reviewed source blobs and dependencies match base {coverage['reviewed_revision']}")


if __name__ == "__main__":
    main()
