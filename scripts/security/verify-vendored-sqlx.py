#!/usr/bin/env python3
"""Verify the SQLx SQLite driver is the reviewed release plus its manifest fix."""
from __future__ import annotations

import hashlib
import sys
import tarfile
import tomllib
from pathlib import Path, PurePosixPath

ARCHIVE = Path("patches/vendor/sqlx-sqlite-0.9.0.crate")
DIRECTORY = Path("patches/vendor/sqlx-sqlite-0.9.0")
UPSTREAM_SHA256 = "488e99c397a62007e4229aec669a179816339afc6d2620ca6fa420dbee2e982c"
PREFIX = "sqlx-sqlite-0.9.0/"
ORIGINAL = b'version = ">=0.30.1, <0.38.0"'
PATCHED = b'version = ">=0.39.1, <0.40.0"'
SQLITE_SHA256 = "14a5f01b87b92705d07b433c06f96cbc764637d81a0bffb5734ce17cf0f9a2b3"
WORKSPACES = (Path("Cargo.toml"), Path("tests/fuzz/cargo/Cargo.toml"))


def verify_bindings(root: Path, directory: Path) -> None:
    for manifest in WORKSPACES:
        manifest_path = root / manifest
        data = tomllib.loads(manifest_path.read_text())
        patch = data.get("patch", {}).get("crates-io", {}).get("sqlx-sqlite")
        if not isinstance(patch, dict) or set(patch) != {"path"}:
            raise ValueError(f"{manifest}: SQLx must use only the reviewed path patch")
        if (manifest_path.parent / patch["path"]).resolve() != directory.resolve():
            raise ValueError(f"{manifest}: SQLx patch points outside the verified source")
        lockfile = manifest_path.with_name("Cargo.lock")
        lock = tomllib.loads(lockfile.read_text())
        packages = lock.get("package", [])
        sqlx = [p for p in packages if p.get("name") == "sqlx-sqlite"]
        sqlite = [p for p in packages if p.get("name") == "libsqlite3-sys"]
        if len(sqlx) != 1 or sqlx[0].get("version") != "0.9.0" or "source" in sqlx[0] or "checksum" in sqlx[0]:
            raise ValueError(f"{lockfile}: SQLx identity is not the reviewed path package")
        if "libsqlite3-sys" not in sqlx[0].get("dependencies", []):
            raise ValueError(f"{lockfile}: SQLx is missing its SQLite dependency")
        if len(sqlite) != 1 or sqlite[0].get("version") != "0.39.1" or sqlite[0].get("checksum") != SQLITE_SHA256:
            raise ValueError(f"{lockfile}: SQLite is not the reviewed fixed version")
        if sqlite[0].get("source") != "registry+https://github.com/rust-lang/crates.io-index":
            raise ValueError(f"{lockfile}: SQLite must come from crates.io")


def verify(root: Path) -> None:
    archive_path, directory = root / ARCHIVE, root / DIRECTORY
    if archive_path.is_symlink() or directory.is_symlink():
        raise ValueError("SQLx source and archive must not be symlinks")
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("SQLx archive does not match the published crate digest")
    expected: dict[str, bytes] = {}
    with tarfile.open(archive_path, "r:gz") as archive:
        for entry in archive:
            name = entry.name
            if not name.startswith(PREFIX) or not entry.isfile():
                raise ValueError("unexpected SQLx archive entry")
            path = PurePosixPath(name[len(PREFIX):])
            if path.is_absolute() or not path.parts or ".." in path.parts:
                raise ValueError("invalid SQLx archive path")
            relative = path.as_posix()
            if relative == "Cargo.lock":
                continue  # Cargo ignores dependency lockfiles; this one is stale.
            if relative in expected:
                raise ValueError("duplicate SQLx archive entry")
            stream = archive.extractfile(entry)
            if stream is None:
                raise ValueError("unreadable SQLx archive entry")
            content = stream.read()
            if relative == "Cargo.toml":
                if content.count(ORIGINAL) != 1:
                    raise ValueError("unexpected SQLx upstream dependency constraint")
                content = content.replace(ORIGINAL, PATCHED)
            expected[relative] = content
    if "Cargo.toml" not in expected:
        raise ValueError("missing SQLx upstream manifest")
    actual = {}
    for item in directory.rglob("*"):
        if item.is_symlink():
            raise ValueError("SQLx source contains a symlink")
        if item.is_file():
            actual[item.relative_to(directory).as_posix()] = item.read_bytes()
        elif not item.is_dir():
            raise ValueError("SQLx source contains a special file")
    if actual.keys() != expected.keys():
        raise ValueError("SQLx source file inventory differs from the published crate")
    changed = sorted(name for name in expected if actual[name] != expected[name])
    if changed:
        raise ValueError("SQLx source differs beyond the manifest fix: " + ", ".join(changed))
    verify_bindings(root, directory)


if __name__ == "__main__":
    try:
        verify(Path(__file__).resolve().parents[2])
    except (OSError, ValueError, tarfile.TarError) as error:
        print(f"vendored SQLx verification: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print("vendored SQLx verification: published 0.9.0 plus reviewed dependency constraint")
