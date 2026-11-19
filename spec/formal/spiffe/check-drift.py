#!/usr/bin/env python3
"""Reject changes to the reviewed implementation and resolved dependency graph."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "security"))
from formal_coverage_drift import assert_reviewed_revision_on_main  # noqa: E402
HELPER = ROOT / "scripts/security/cargo-lock-projection.py"
SPEC = importlib.util.spec_from_file_location("cargo_lock_projection", HELPER)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("spiffe-formal: lock projection helper is unavailable")
projection = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = projection
SPEC.loader.exec_module(projection)
ROOT_PACKAGE = "opensesame-spiffe-source"
ALGORITHM = "cargo-lock-projection-v1-sha256"


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
        revision = str(coverage.get("reviewed_revision", ""))
        if coverage.get("version") != 1 or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("invalid coverage manifest")
        assert_reviewed_revision_on_main(ROOT, revision, "spiffe-formal")
        for item in coverage["sources"]:
            digest = hashlib.sha256((ROOT / item["path"]).read_bytes()).hexdigest()
            if digest != item["sha256"]:
                raise ValueError(f"review source drift: {item['path']}")
        graph = projection.read_lock(ROOT / "Cargo.lock")
        verify_lock(coverage, graph, (ROOT / "crates/spiffe-source/src/lib.rs").read_text())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"spiffe-formal: {exc}") from exc
    print("spiffe-formal: reviewed source and resolved dependency graph match")


if __name__ == "__main__":
    main()
