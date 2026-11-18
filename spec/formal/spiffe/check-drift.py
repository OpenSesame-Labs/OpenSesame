#!/usr/bin/env python3
"""Reject changes to the reviewed implementation and resolved dependency graph."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "scripts/security/cargo-lock-projection.py"
for path in (ROOT / "scripts", ROOT / "scripts/security", HELPER):
    if not (stat.S_ISREG(path.lstat().st_mode) if path == HELPER else stat.S_ISDIR(path.lstat().st_mode)):
        raise SystemExit("spiffe-formal: projection helper path is not regular")
SPEC = importlib.util.spec_from_file_location("cargo_lock_projection", HELPER)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("spiffe-formal: lock projection helper is unavailable")
projection = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = projection
exec(compile(HELPER.read_bytes(), str(HELPER), "exec", dont_inherit=True), projection.__dict__)
ROOT_PACKAGE = "opensesame-spiffe-source"
ALGORITHM = "cargo-lock-projection-v1-sha256"
MINIMUM_PATHS = {
    'crates/spiffe-source/Cargo.toml',
    'crates/spiffe-source/src/source.rs',
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
    'crates/transport-security/src/source_trust.rs',
    'crates/domain/Cargo.toml',
    'crates/domain/src/lib.rs',
}
OPTIONAL_PATHS = [
    "crates/domain/build.rs",
    "crates/spiffe-source/build.rs",
    "crates/transport-security/build.rs",
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


def verify_lock(coverage, graph, sdk_source):
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


def main():
    try:
        coverage = json.loads((ROOT / "spec/formal/spiffe/coverage.json").read_text())
        entries = coverage["sources"]
        paths = [item["path"] for item in entries]
        if (coverage.get("version") != 1 or len(paths) != len(set(paths)) or
                not MINIMUM_PATHS.issubset(paths) or
                not re.fullmatch(r"[0-9a-f]{40}", str(coverage.get("reviewed_revision", "")))):
            raise ValueError("invalid reviewed source manifest")
        for item in entries:
            digest = hashlib.sha256(regular_path(item["path"]).read_bytes()).hexdigest()
            if digest != item["sha256"]:
                raise ValueError(f"review source drift: {item['path']}")
        optional = coverage["optional_sources"]
        if ([entry.get("path") for entry in optional] != OPTIONAL_PATHS or
                any(optional_hash(entry["path"]) != entry["sha256"] for entry in optional)):
            raise ValueError("review optional source/build-script drift")
        graph = projection.read_lock(ROOT / "Cargo.lock")
        verify_lock(coverage, graph, (ROOT / "crates/spiffe-source/src/lib.rs").read_text())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"spiffe-formal: {exc}") from exc
    print("spiffe-formal: reviewed source and resolved dependency graph match")


if __name__ == "__main__":
    main()
