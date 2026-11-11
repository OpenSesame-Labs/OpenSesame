#!/usr/bin/env python3
"""Verify the local source subset before trusting its upstream advisory scan."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
SUBSET = ROOT / "third_party" / "x-crypto"
DIRECTORIES = {
    "cryptobyte", "chacha20", "chacha20poly1305", "internal/alias", "internal/poly1305"
}
# Closed set. These tests are compiled from the pinned module via -overlay.
# Any other omission remains a package-boundary failure.
OVERLAY_VECTORS = {
    "chacha20/vectors_test.go",
    "internal/poly1305/vectors_test.go",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def allowed_source(name):
    return name in {"LICENSE", "PATENTS"} or any(
        name.startswith(directory + "/") for directory in DIRECTORIES
    )


def regular_file(root, name):
    cursor = Path(root)
    if cursor.is_symlink() or not cursor.is_dir():
        raise ValueError("downloaded upstream directory is not a real directory")
    for part in Path(name).parts:
        if part in {"", ".", ".."}:
            raise ValueError(f"unexpected upstream source path: {name}")
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError(f"canonical path contains a symlink: {name}")
    if not cursor.is_file():
        raise ValueError(f"canonical test vector missing: {name}")
    return cursor


def verify(upstream_metadata=None, imports=None, overlay_path=None):
    manifest = json.loads((SUBSET / "UPSTREAM.json").read_text())
    if manifest["module"] != "golang.org/x/crypto":
        raise ValueError("upstream module identity changed")
    if set(manifest["directories"]) != DIRECTORIES:
        raise ValueError("source subset package boundary changed")
    files = manifest["files"]
    vectors = manifest["test_vector_files"]
    if set(vectors) != OVERLAY_VECTORS:
        raise ValueError("test vector overlay set changed")
    if set(vectors) & set(files):
        raise ValueError("test vector files must not be vendored")
    if not files or any(not allowed_source(name) for name in (*files, *vectors)):
        raise ValueError("unexpected upstream source path")
    expected = set(files) | {"UPSTREAM.json", "go.mod", "go.sum"}
    if SUBSET.is_symlink():
        raise ValueError("source subset is a symlink")
    actual = set()
    for path in SUBSET.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"source subset contains symlink: {path}")
        if path.is_file():
            actual.add(path.relative_to(SUBSET).as_posix())
    if actual != expected:
        raise ValueError(f"source files differ: missing={expected - actual}, extra={actual - expected}")
    for name, expected_digest in files.items():
        if digest((SUBSET / name).read_bytes()) != expected_digest:
            raise ValueError(f"upstream source drift: {name}")
    expected_mod = "module golang.org/x/crypto\n\ngo 1.26.11\n\nrequire golang.org/x/sys v0.49.0\n"
    if (SUBSET / "go.mod").read_text() != expected_mod:
        raise ValueError("subset module metadata changed")
    project = (ROOT / "go.mod").read_text()
    version = re.escape(manifest["version"])
    if not re.search(r"^\s*golang\.org/x/crypto " + version + r"(?:\s|$)", project, re.M):
        raise ValueError("project and subset upstream versions disagree")
    if "replace golang.org/x/crypto => ./third_party/x-crypto" not in project:
        raise ValueError("project source replacement changed")
    if overlay_path and not upstream_metadata:
        raise ValueError("overlay requires checksum-verified upstream metadata")
    if upstream_metadata:
        upstream = json.loads(Path(upstream_metadata).read_text())
        if upstream.get("Error"):
            raise ValueError(upstream["Error"])
        if (upstream["Path"], upstream["Version"], upstream["Sum"]) != (
            manifest["module"], manifest["version"], manifest["sum"]
        ):
            raise ValueError("downloaded upstream identity/integrity differs")
        if upstream.get("Origin", {}).get("Hash") != manifest["commit"]:
            raise ValueError("downloaded upstream commit differs")
        source = Path(upstream["Dir"])
        subset_abs = SUBSET.absolute()
        source_abs = source.absolute()
        if source_abs == subset_abs or subset_abs in source_abs.parents:
            raise ValueError("upstream directory aliases the vendored tree")
        upstream_files = {"LICENSE", "PATENTS"}
        for directory in DIRECTORIES:
            directory_root = source / directory
            if directory_root.is_symlink() or not directory_root.is_dir():
                raise ValueError(f"upstream package directory missing: {directory}")
            upstream_files.update(
                path.relative_to(source).as_posix()
                for path in directory_root.rglob("*") if path.is_file()
            )
        if upstream_files != set(files) | set(vectors):
            raise ValueError("upstream package files were omitted or added")
        for name in files:
            if (SUBSET / name).read_bytes() != (source / name).read_bytes():
                raise ValueError(f"source differs from canonical upstream: {name}")
        verified_paths = {}
        for name, expected_digest in vectors.items():
            canonical = regular_file(source, name)
            blob = canonical.read_bytes()
            if digest(blob) != expected_digest:
                raise ValueError(f"source differs from canonical upstream: {name}")
            verified_paths[name] = canonical
        if overlay_path:
            replace = {}
            for name, canonical in verified_paths.items():
                blob = canonical.read_bytes()
                if digest(blob) != vectors[name]:
                    raise ValueError(f"source differs from canonical upstream: {name}")
                replace[os.path.abspath(SUBSET / name)] = os.path.abspath(canonical)
            Path(overlay_path).write_text(json.dumps({"Replace": replace}, indent=2) + "\n")
    if imports:
        packages = {
            manifest["module"] + "/" + str(Path(name).parent)
            for name in (*files, *vectors) if name.endswith(".go")
        }
        analyzed = set(Path(imports).read_text().splitlines())
        if packages - analyzed:
            raise ValueError(f"source packages omitted from advisory analysis: {packages - analyzed}")
    print(
        f"Verified x/crypto {manifest['version']}: {len(files)} unchanged upstream files, "
        f"{len(vectors)} pinned test vectors; OpenPGP absent"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-metadata")
    parser.add_argument("--imports")
    parser.add_argument("--overlay")
    args = parser.parse_args()
    try:
        verify(args.upstream_metadata, args.imports, args.overlay)
    except (OSError, ValueError, KeyError) as error:
        print(f"crypto subset verification failed: {error}", file=sys.stderr)
        sys.exit(1)
