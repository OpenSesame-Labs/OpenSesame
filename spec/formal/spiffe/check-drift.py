#!/usr/bin/env python3
"""Reject changes to the reviewed implementation and resolved dependency graph.

Each covered source records a sha256 of the reviewed bytes and the git blob id
of those bytes (`reviewed_blob`). The worktree file and `git cat-file blob`
must both hash to that sha256, so a coverage edit cannot point at bytes the
repository does not contain. `reviewed_revision` stays a main ancestor. Its
tree is the pre-fix base: `base_blob` is `git rev-parse revision:path` when the
path existed there, and null when it did not. `git show revision:path` must
hash to that base blob. The security fix itself is the reviewed blob, which is
what remains reachable after a squash merge replaces the branch commit.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "security"))
from formal_coverage_drift import assert_reviewed_revision_on_main  # noqa: E402

ROOT_PACKAGE = "opensesame-spiffe-source"
ALGORITHM = "cargo-lock-projection-v1-sha256"
TARGETS = {
    "crates/domain/Cargo.toml": {"package": "opensesame-domain", "lib": ("opensesame_domain", "src/lib.rs")},
    "crates/transport-security/Cargo.toml": {
        "package": "opensesame-transport-security", "lib": ("opensesame_transport_security", "src/lib.rs"),
    },
    "crates/spiffe-source/Cargo.toml": {
        "package": "opensesame-spiffe-source", "lib": ("opensesame_spiffe_source", "src/lib.rs"),
        "test": {name: f"tests/{name}.rs" for name in (
            "synthetic_workload_api", "withdrawal_policy", "outage_policy", "trust_reduction_policy", "production_sink_policy",
        )},
    },
}
MINIMUM_PATHS = {
    'crates/spiffe-source/Cargo.toml',
    'crates/spiffe-source/src/source.rs',
    'crates/spiffe-source/src/source_loop.rs',
    'crates/spiffe-source/src/source_history_flow.rs',
    'crates/spiffe-source/src/source_policy.rs',
    'crates/spiffe-source/src/bundles.rs',
    'crates/spiffe-source/src/outage.rs',
    'crates/spiffe-source/src/status.rs',
    'crates/spiffe-source/src/source_formal_tests.rs',
    'crates/spiffe-source/src/fake/server.rs',
    'crates/spiffe-source/tests/synthetic_workload_api.rs',
    'crates/spiffe-source/tests/withdrawal_policy.rs',
    'crates/spiffe-source/tests/outage_policy.rs',
    'crates/spiffe-source/tests/trust_reduction_policy.rs',
    'crates/spiffe-source/tests/support/policy.rs',
    'crates/spiffe-source/src/snapshot.rs',
    'crates/spiffe-source/src/error.rs',
    'crates/spiffe-source/src/config.rs',
    'crates/spiffe-source/src/svid_profile.rs',
    'crates/spiffe-source/src/sink.rs',
    'crates/spiffe-source/src/sink/transport.rs',
    'crates/transport-security/src/generations.rs',
    'crates/spiffe-source/src/lib.rs',
    'crates/spiffe-source/tests/production_sink_policy.rs',
    'crates/spiffe-source/src/source_handle.rs',
    'crates/transport-security/src/source_lifetime.rs',
    'crates/transport-security/src/source_history_activation.rs',
    'crates/transport-security/src/source_trust.rs',
    'crates/transport-security/src/svid_profile.rs',
    'crates/transport-security/Cargo.toml',
    'crates/transport-security/src/lib.rs',
    'crates/domain/Cargo.toml',
    'crates/domain/src/lib.rs',
    'scripts/security/formal-cargo-isolation.py',
    'scripts/security/formal-cargo-freshness.py',
    'scripts/security/formal_cargo_packages.py',
    'scripts/security/cargo-lock-projection.py',
}
OPTIONAL_PATHS = [
    "crates/domain/build.rs",
    "crates/spiffe-source/build.rs",
    "crates/transport-security/build.rs",
]
ATTESTATION_RE = re.compile(r"spec/formal/spiffe/reviewed-sources(?:-[a-z0-9-]+)?\.json\Z")
BLOB_RE = re.compile(r"[0-9a-f]{40}\Z")
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")


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


def sdk_projection(graph):
    sdk = graph.select(ROOT_PACKAGE, "spiffe")

    def identity(package):
        return {
            "name": package.name,
            "version": package.version,
            "source": package.source or None,
            "checksum": graph.packages[package].checksum,
        }

    direct = [identity(dep) for dep in graph.edges[sdk]]
    return {
        "package": identity(sdk),
        "direct_dependencies": sorted(
            direct, key=lambda item: (item["name"], item["version"], item["source"] or "")
        ),
    }


def verify_lock(coverage, graph, sdk_source, projection):
    recorded = coverage.get("lock_projection")
    if not isinstance(recorded, dict) or recorded.get("root") != ROOT_PACKAGE or recorded.get("algorithm") != ALGORITHM:
        raise ValueError("reviewed lock projection is missing or malformed")
    if projection.projection_sha256(graph, ROOT_PACKAGE) != recorded.get("sha256"):
        raise ValueError("review resolved SPIFFE source dependency graph drift")
    sdk = graph.select(ROOT_PACKAGE, "spiffe")
    if sdk_projection(graph) != coverage.get("sdk_projection"):
        raise ValueError("review resolved SPIFFE SDK dependency drift")
    matches = re.findall(
        r'^\s*pub const SDK: &str = concat!\(\s*"spiffe "\s*,\s*"([^"]+)"\s*\);',
        sdk_source, re.MULTILINE,
    )
    if len(matches) != 1 or matches[0] != sdk.version:
        raise ValueError("advertised SPIFFE SDK version differs from the resolved direct dependency")


def git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(ROOT), *args],
        capture_output=True,
        env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
        check=False,
    )


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


def verify_sources(coverage: dict, revision: str) -> dict[str, bytes]:
    attestation_path = coverage.get("reviewed_attestation")
    if not isinstance(attestation_path, str) or ATTESTATION_RE.fullmatch(attestation_path) is None:
        raise ValueError("reviewed attestation path is missing or malformed")
    attestation = json.loads((ROOT / attestation_path).read_text())
    sources = coverage.get("sources")
    if attestation.get("version") != 1 or attestation.get("sources") != sources:
        raise ValueError("manifest does not match reviewed-source attestation")
    if not isinstance(sources, list) or not sources:
        raise ValueError("covered sources are missing")
    verified = {}
    for item in sources:
        path = item["path"]
        expected = item["sha256"]
        if not isinstance(path, str) or SHA_RE.fullmatch(str(expected)) is None:
            raise ValueError(f"malformed covered source entry for {path!r}")
        if path.startswith("/") or ".." in Path(path).parts:
            raise ValueError(f"covered source path must stay in-repo: {path!r}")
        work = hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
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
        verified[path] = (ROOT / path).read_bytes()
    return verified


def main():
    try:
        coverage = json.loads((ROOT / "spec/formal/spiffe/coverage.json").read_text())
        revision = str(coverage.get("reviewed_revision", ""))
        if coverage.get("version") != 2 or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("invalid coverage manifest")
        assert_reviewed_revision_on_main(ROOT, revision, "spiffe-formal")
        verified = verify_sources(coverage, revision)
        paths = list(verified)
        if len(paths) != len(set(paths)) or not MINIMUM_PATHS.issubset(paths):
            raise ValueError("invalid reviewed source manifest")
        optional = coverage["optional_sources"]
        if ([entry.get("path") for entry in optional] != OPTIONAL_PATHS or
                any(optional_hash(entry["path"]) != entry["sha256"] for entry in optional)):
            raise ValueError("review optional source/build-script drift")
        helper_name = "scripts/security/formal-cargo-isolation.py"
        scope = {"__name__": "reviewed_cargo_isolation", "__file__": str(ROOT / helper_name)}
        exec(compile(verified[helper_name], scope["__file__"], "exec", dont_inherit=True), scope)
        scope["check_cargo_targets"](ROOT, TARGETS, set(verified))
        helper_name = "scripts/security/cargo-lock-projection.py"
        helper = regular_path(helper_name)
        spec = importlib.util.spec_from_file_location("cargo_lock_projection", helper)
        if spec is None or spec.loader is None:
            raise ValueError("lock projection helper unavailable")
        projection = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = projection
        exec(compile(verified[helper_name], str(helper), "exec", dont_inherit=True), projection.__dict__)
        graph = projection.read_lock(ROOT / "Cargo.lock")
        verify_lock(coverage, graph, (ROOT / "crates/spiffe-source/src/lib.rs").read_text(), projection)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"spiffe-formal: {exc}") from exc
    print("spiffe-formal: reviewed source blobs and resolved dependency graph match")


if __name__ == "__main__":
    main()
