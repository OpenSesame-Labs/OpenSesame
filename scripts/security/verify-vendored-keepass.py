#!/usr/bin/env python3
"""Verify the vendored Keepass crate is the published release plus one reviewed fix."""
from __future__ import annotations

import hashlib
import sys
import tarfile
import tomllib
from pathlib import Path, PurePosixPath

ARCHIVE = Path("patches/vendor/keepass-0.17.0.crate")
DIRECTORY = Path("patches/vendor/keepass-0.17.0")
UPSTREAM_SHA256 = "8025344cf174f72cccbac2a99640a8d1e82cf46922d57e06a45a32e49edfed16"
PREFIX = "keepass-0.17.0/"
PATCHED_FILE = "src/format/xml_db/timestamp.rs"
UPSTREAM_FILE_SHA256 = "189c7c2234d40257f0cec60f5f1db2b8aa843b1d9ecb55f8d214f7c0b6be0a41"
PATCHED_FILE_SHA256 = "2addedf1e8a6fc035249b783b76542a4610d0aab4d7a060840088fc7c82b7a82"
WORKSPACES = (Path("Cargo.toml"), Path("tests/fuzz/cargo/Cargo.toml"))


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def verify_bindings(root: Path, directory: Path) -> None:
    for manifest in WORKSPACES:
        manifest_path = root / manifest
        data = tomllib.loads(manifest_path.read_text())
        patch = data.get("patch", {}).get("crates-io", {}).get("keepass")
        if not isinstance(patch, dict) or set(patch) != {"path"}:
            raise ValueError(f"{manifest}: Keepass must use only the reviewed path patch")
        if (manifest_path.parent / patch["path"]).resolve() != directory.resolve():
            raise ValueError(f"{manifest}: Keepass patch points outside the verified source")
        lockfile = manifest_path.with_name("Cargo.lock")
        packages = tomllib.loads(lockfile.read_text()).get("package", [])
        keepass = [package for package in packages if package.get("name") == "keepass"]
        if (
            len(keepass) != 1
            or keepass[0].get("version") != "0.17.0"
            or "source" in keepass[0]
            or "checksum" in keepass[0]
        ):
            raise ValueError(f"{lockfile}: Keepass identity is not the reviewed path package")


def verify(root: Path) -> None:
    archive_path, directory = root / ARCHIVE, root / DIRECTORY
    if archive_path.is_symlink() or directory.is_symlink():
        raise ValueError("Keepass source and archive must not be symlinks")
    if digest(archive_path.read_bytes()) != UPSTREAM_SHA256:
        raise ValueError("Keepass archive does not match the published crate digest")

    expected: dict[str, bytes] = {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for entry in archive:
            if not entry.name.startswith(PREFIX) or not entry.isfile():
                raise ValueError("unexpected Keepass archive entry")
            path = PurePosixPath(entry.name[len(PREFIX):])
            if path.is_absolute() or not path.parts or ".." in path.parts:
                raise ValueError("invalid Keepass archive path")
            relative = path.as_posix()
            if relative in expected:
                raise ValueError("duplicate Keepass archive entry")
            stream = archive.extractfile(entry)
            if stream is None:
                raise ValueError("unreadable Keepass archive entry")
            expected[relative] = stream.read()

    if PATCHED_FILE not in expected or digest(expected[PATCHED_FILE]) != UPSTREAM_FILE_SHA256:
        raise ValueError("published Keepass timestamp source is not the reviewed version")

    actual: dict[str, bytes] = {}
    for item in directory.rglob("*"):
        if item.is_symlink():
            raise ValueError("Keepass source contains a symlink")
        if item.is_file():
            actual[item.relative_to(directory).as_posix()] = item.read_bytes()
        elif not item.is_dir():
            raise ValueError("Keepass source contains a special file")
    if actual.keys() != expected.keys():
        raise ValueError("Keepass source file inventory differs from the published crate")

    changed = sorted(name for name in expected if actual[name] != expected[name])
    if changed != [PATCHED_FILE]:
        raise ValueError("Keepass source differs outside the timestamp fix: " + ", ".join(changed))
    if digest(actual[PATCHED_FILE]) != PATCHED_FILE_SHA256:
        raise ValueError("Keepass timestamp fix does not match the reviewed source")
    manifest = tomllib.loads(actual["Cargo.toml"].decode())
    if manifest.get("package", {}).get("name") != "keepass" or manifest["package"].get("version") != "0.17.0":
        raise ValueError("Keepass package identity differs")
    verify_bindings(root, directory)


if __name__ == "__main__":
    try:
        verify(Path(__file__).resolve().parents[2])
    except (OSError, ValueError, UnicodeDecodeError, tarfile.TarError, tomllib.TOMLDecodeError) as error:
        print(f"vendored Keepass verification: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print("vendored Keepass verification: published 0.17.0 plus reviewed timestamp fix")
