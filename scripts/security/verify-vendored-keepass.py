#!/usr/bin/env python3
"""Verify published Keepass plus the exact reviewed timestamp-facade patch."""
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
PATCHED_FILES = {
    "Cargo.toml": "d6fde4aa08f1f13f78df6aee716f4ff0deb6aad561c7c1123d583c6610a33cc4",
    "src/db/merge.rs": "7cf1e2b277d8104629f9c84a686a888600f51659aa777142fd6672b94d18cb8a",
    "src/db/mod.rs": "eae12ba5b08cb22984bdfe13c1d4f0623870810fc7105a7ca67c506cbd8e47af",
    "src/db/otp.rs": "7f0d654b8aaddf15e829fc1aa03d3ee302e84b585b6de8050d54a25b384dace0",
    "src/db/types/color.rs": "8735c6ef1d3037e7cb55245fd71ed464455e6446ede83477cb55323deae85323",
    "src/db/types/custom_data.rs": "ad660d486968798a8fa08159db1e8920a04a72bb0eae5e28ad1d9b8e09d89c6a",
    "src/db/types/entry.rs": "10ceedd73ae162996b1479264f55c7dcbf3ad04a6cb8f196d6d478501bbc2b4f",
    "src/db/types/group.rs": "86c7c2aea9f0ee6e078c57dd9737557852484052f1d6a274997db0e655d36f68",
    "src/db/types/icon.rs": "35f3a7fc6cde0170bb31eb9f46e22e4a5131fcf9553b004001ec1659ded6db61",
    "src/db/types/meta.rs": "6d3391e493a46e189010a7a9b4a31c5b77f488f34fbe210234624e18304bf2e5",
    "src/db/types/mod.rs": "d5710b74261a9e374e2753077dfddf8a559ece1ae643931526e9ebb4d285a115",
    "src/db/types/times.rs": "68c7e81fcfd30725d887b6f462aef593a4167e31baa3fd45ecc740a4eaef8785",
    "src/db/types/value.rs": "59797c4f360a1530f6062eb049bc490efa42d80f8391d3ed84216eace6a085cd",
    "src/format/xml_db/custom_serde.rs": "844c84c9958e181cc9dc613ca5fad009879cc50e53ec045eabc9eba2e0014445",
    "src/format/xml_db/entry.rs": "520af184709f80b7f236467ab58e984db70af96e2d952d451c6806197dc04fb0",
    "src/format/xml_db/group.rs": "e8f18b2d396f5b388d45d8abb16f926e307ea2bea5b26d5fe77dac9dab525aa2",
    "src/format/xml_db/meta.rs": "4e2e3c589a1a7d2181053fb7cc037ea9bd16ec0571e16faf1712f588e8dd5b79",
    "src/format/xml_db/mod.rs": "518a3b9ad83925f824d9cb24934874f9868e738f4ae432928c3f0273f10ff4eb",
    "src/format/xml_db/times.rs": "7d9b9f8356f7db1d769b1f70312a6a7e8bb2d07959e72e3d5c4e95baba2c1a3c",
    "src/format/xml_db/timestamp.rs": "43a5f094440450ba2c1dcff163a22749a1b679ae1e3f8991c3afe40825a839a6",
}
WORKSPACES = (Path("Cargo.toml"), Path("tests/fuzz/cargo/Cargo.toml"))
FORMATTED_METADATA = ".cargo_vcs_info.json"


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
            if relative == "Cargo.lock":
                continue  # Cargo ignores dependency lockfiles; this one is stale.
            if relative in expected:
                raise ValueError("duplicate Keepass archive entry")
            stream = archive.extractfile(entry)
            if stream is None:
                raise ValueError("unreadable Keepass archive entry")
            content = stream.read()
            if relative == FORMATTED_METADATA:
                # Biome requires text files to end in one newline. The crate's
                # JSON metadata omits it; normalize only this packaging file.
                content = content.rstrip(b"\n") + b"\n"
            expected[relative] = content

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
    if changed != sorted(PATCHED_FILES):
        raise ValueError("Keepass source differs outside the reviewed facade patch: " + ", ".join(changed))
    mismatched = sorted(name for name, expected_hash in PATCHED_FILES.items()
                        if digest(actual[name]) != expected_hash)
    if mismatched:
        raise ValueError("Keepass facade patch does not match reviewed source: " + ", ".join(mismatched))
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
    print("vendored Keepass verification: published 0.17.0 plus reviewed timestamp facade")
