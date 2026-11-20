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
import subprocess
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
ATTESTATION_RE = re.compile(r"spec/formal/spiffe/reviewed-sources(?:-[a-z0-9-]+)?\.json\Z")
BLOB_RE = re.compile(r"[0-9a-f]{40}\Z")
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")


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


def verify_sources(coverage: dict, revision: str) -> None:
    attestation_path = coverage.get("reviewed_attestation")
    if not isinstance(attestation_path, str) or ATTESTATION_RE.fullmatch(attestation_path) is None:
        raise ValueError("reviewed attestation path is missing or malformed")
    attestation = json.loads((ROOT / attestation_path).read_text())
    sources = coverage.get("sources")
    if attestation.get("version") != 1 or attestation.get("sources") != sources:
        raise ValueError("manifest does not match reviewed-source attestation")
    if not isinstance(sources, list) or not sources:
        raise ValueError("covered sources are missing")
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
            continue
        if ancestor != base_blob:
            raise ValueError(f"reviewed revision blob for {path} does not match base_blob")
        shown = git("show", f"{revision}:{path}")
        if shown.returncode != 0:
            raise ValueError(f"reviewed revision bytes unavailable for {path}")
        if hashlib.sha256(shown.stdout).hexdigest() != hashlib.sha256(blob_bytes(base_blob)).hexdigest():
            raise ValueError(f"reviewed revision bytes do not match base blob: {path}")


def main():
    try:
        coverage = json.loads((ROOT / "spec/formal/spiffe/coverage.json").read_text())
        revision = str(coverage.get("reviewed_revision", ""))
        if coverage.get("version") != 2 or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("invalid coverage manifest")
        assert_reviewed_revision_on_main(ROOT, revision, "spiffe-formal")
        verify_sources(coverage, revision)
        graph = projection.read_lock(ROOT / "Cargo.lock")
        verify_lock(coverage, graph, (ROOT / "crates/spiffe-source/src/lib.rs").read_text())
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"spiffe-formal: {exc}") from exc
    print("spiffe-formal: reviewed source blobs and resolved dependency graph match")


if __name__ == "__main__":
    main()
