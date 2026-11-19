#!/usr/bin/env python3
"""Compare resolved Cargo.lock closures without running Cargo or project code.

The CLI writes one JSON object, {"changed": true|false}, on success. Parsing,
resolution, selection, and file errors exit nonzero, so callers must not treat
an error as an unchanged graph. Cargo.lock records do not identify active
features, targets, or dev/build dependency kinds, and do not cover Cargo.toml,
Cargo configuration, patches, or replacement inputs; handle those separately.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import sys
import tomllib

_NAME = r"[A-Za-z0-9][A-Za-z0-9_-]*"
_VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
_REFERENCE = re.compile(rf"(?P<name>{_NAME})(?: (?P<version>{_VERSION})(?: \((?P<source>\S+)\))?)?\Z")
_PACKAGE_NAME = re.compile(rf"{_NAME}\Z")
_PACKAGE_VERSION = re.compile(rf"{_VERSION}\Z")
_SOURCE = re.compile(r"(?:registry|sparse|git)\+\S+\Z")
_CHECKSUM = re.compile(r"[0-9a-f]{64}\Z")
_FIELDS = {"name", "version", "source", "checksum", "dependencies"}


class LockError(ValueError):
    """An unsupported, invalid, or ambiguous lock graph."""


class MissingSelection(LockError):
    """A unique workspace root or named direct dependency is absent."""


@dataclass(frozen=True, order=True)
class PackageId:
    name: str
    version: str
    # Empty source represents a path/workspace package; actual sources cannot be empty.
    source: str


@dataclass(frozen=True)
class Package:
    identity: PackageId
    checksum: str | None
    references: tuple[str, ...]


def _version(value: object) -> bool:
    if not isinstance(value, str) or not _PACKAGE_VERSION.fullmatch(value):
        return False
    prerelease = value.split("+", 1)[0].partition("-")[2]
    return all(not (part.isdigit() and len(part) > 1 and part[0] == "0")
               for part in prerelease.split(".") if part)


def _source(value: object) -> bool:
    return isinstance(value, str) and _SOURCE.fullmatch(value) is not None


def _read_package(raw: object) -> Package:
    if not isinstance(raw, dict):
        raise LockError("package entry must be a table")
    extra = set(raw) - _FIELDS
    if extra:
        raise LockError(f"unsupported package fields: {', '.join(sorted(extra))}")
    name, version = raw.get("name"), raw.get("version")
    if not isinstance(name, str) or not _PACKAGE_NAME.fullmatch(name):
        raise LockError("package name is missing or malformed")
    if not _version(version):
        raise LockError(f"package {name}: missing or malformed version")
    source = raw.get("source")
    if source is not None and not _source(source):
        raise LockError(f"package {name}: malformed source")
    checksum = raw.get("checksum")
    if checksum is not None and (not isinstance(checksum, str) or not _CHECKSUM.fullmatch(checksum)):
        raise LockError(f"package {name}: malformed checksum")
    if source and source.startswith(("registry+", "sparse+")) and checksum is None:
        raise LockError(f"package {name}: registry checksum is missing")
    refs = raw.get("dependencies", [])
    if not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs):
        raise LockError(f"package {name}: dependencies must be an array of strings")
    return Package(PackageId(name, version, source or ""), checksum, tuple(refs))


def _parse_reference(reference: str) -> tuple[str, str | None, str | None]:
    match = _REFERENCE.fullmatch(reference)
    if not match:
        raise LockError("malformed dependency reference")
    name, version, source = match.group("name", "version", "source")
    if version is not None and not _version(version):
        raise LockError(f"dependency {name}: malformed version")
    if source is not None and not _source(source):
        raise LockError(f"dependency {name}: malformed source")
    return name, version, source


class LockGraph:
    def __init__(self, document: dict):
        if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] not in (3, 4):
            raise LockError("only Cargo.lock format versions 3 and 4 are supported")
        extra = set(document) - {"version", "package", "metadata", "patch"}
        if extra:
            raise LockError(f"unsupported lockfile fields: {', '.join(sorted(extra))}")
        metadata = document.get("metadata", {})
        if not isinstance(metadata, dict) or any(key.startswith("checksum ") for key in metadata):
            raise LockError("legacy metadata checksums are unsupported")
        patch = document.get("patch", {})
        if not isinstance(patch, dict) or set(patch) - {"unused"}:
            raise LockError("unsupported lockfile patch fields")
        if "unused" in patch and (not isinstance(patch["unused"], list) or any(not isinstance(item, dict) for item in patch["unused"])):
            raise LockError("unused patches must be an array of tables")
        raw_packages = document.get("package")
        if not isinstance(raw_packages, list) or not raw_packages:
            raise LockError("lockfile must contain package tables")
        self.packages: dict[PackageId, Package] = {}
        by_name: dict[str, list[PackageId]] = {}
        for raw in raw_packages:
            package = _read_package(raw)
            identity = package.identity
            if identity in self.packages:
                raise LockError(f"duplicate package identity: {identity.name} {identity.version}")
            self.packages[identity] = package
            by_name.setdefault(identity.name, []).append(identity)

        self.edges: dict[PackageId, tuple[PackageId, ...]] = {}
        for package in self.packages.values():
            resolved: list[PackageId] = []
            for reference in package.references:
                name, version, source = _parse_reference(reference)
                matches = [candidate for candidate in by_name.get(name, ())
                           if (version is None or candidate.version == version)
                           and (source is None or candidate.source == source)]
                if len(matches) != 1:
                    raise LockError(f"{package.identity.name}: dependency {name} resolved to {len(matches)} packages")
                resolved.append(matches[0])
            if len(set(resolved)) != len(resolved):
                raise LockError(f"{package.identity.name}: duplicate resolved dependency")
            self.edges[package.identity] = tuple(sorted(resolved))

    def select(self, root_name: str, dependency_name: str | None = None) -> PackageId:
        roots = [identity for identity in self.packages
                 if identity.name == root_name and identity.source == ""]
        if not roots:
            raise MissingSelection(f"workspace root {root_name!r} is absent")
        if len(roots) != 1:
            raise LockError(f"workspace root {root_name!r} resolved to {len(roots)} packages")
        root = roots[0]
        if dependency_name is not None:
            matches = [dep for dep in self.edges[root] if dep.name == dependency_name]
            if not matches:
                raise MissingSelection(f"direct dependency {dependency_name!r} is absent")
            if len(matches) != 1:
                raise LockError(f"direct dependency {dependency_name!r} resolved to {len(matches)} packages")
            root = matches[0]
        return root

    def projection(self, root_name: str, dependency_name: str | None = None) -> tuple:
        root = self.select(root_name, dependency_name)
        visited: set[PackageId] = set()
        pending = [root]
        while pending:
            node = pending.pop()
            if node not in visited:
                visited.add(node)
                pending.extend(self.edges[node])
        return tuple((node, self.packages[node].checksum, self.edges[node])
                     for node in sorted(visited))


def projection_sha256(graph: LockGraph, root: str, dependency: str | None = None) -> str:
    """Hash the canonical resolved graph used by the comparator."""
    def identity(package: PackageId) -> dict:
        return {"name": package.name, "version": package.version, "source": package.source or None}

    records = [
        {**identity(node), "checksum": checksum,
         "dependencies": [identity(target) for target in edges]}
        for node, checksum, edges in graph.projection(root, dependency)
    ]
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_lock(path: Path) -> LockGraph:
    try:
        with path.open("rb") as handle:
            return LockGraph(tomllib.load(handle))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise LockError(f"cannot read {path}: {exc}") from exc


def optional_projection(graph: LockGraph, root: str, dependency: str | None) -> tuple | None:
    try:
        return graph.projection(root, dependency)
    except MissingSelection:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="workspace package name")
    parser.add_argument("--dependency", help="select one named direct dependency instead of the full root closure")
    parser.add_argument("--allow-absent", action="store_true", help="compare an absent root or direct dependency as an absent graph")
    parser.add_argument("before", type=Path, help="path containing the before Cargo.lock blob")
    parser.add_argument("after", type=Path, help="path containing the after Cargo.lock blob")
    args = parser.parse_args(argv)
    try:
        before_graph = read_lock(args.before)
        after_graph = read_lock(args.after)
        if args.allow_absent:
            before = optional_projection(before_graph, args.root, args.dependency)
            after = optional_projection(after_graph, args.root, args.dependency)
        else:
            before = before_graph.projection(args.root, args.dependency)
            after = after_graph.projection(args.root, args.dependency)
    except LockError as exc:
        print(f"cargo-lock-projection: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"changed": before != after}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
