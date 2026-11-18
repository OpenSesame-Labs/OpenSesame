#!/usr/bin/env python3
"""Compare the Cargo workspace inputs to one reviewed package.

The projection is deliberately conservative about global Cargo settings and
the lock graph: it includes optional, development and target dependencies.
It does not model feature unification caused by other workspace packages.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tomllib

sys.dont_write_bytecode = True
_LOCK_PATH = Path(__file__).with_name("cargo-lock-projection.py")
if not stat.S_ISREG(_LOCK_PATH.lstat().st_mode):
    raise RuntimeError("Cargo lock projection helper must be a regular file")
_LOCK_SPEC = importlib.util.spec_from_file_location("cargo_lock_projection", _LOCK_PATH)
if _LOCK_SPEC is None or _LOCK_SPEC.loader is None:
    raise RuntimeError("Cargo lock projection helper is unavailable")
lock_projection = importlib.util.module_from_spec(_LOCK_SPEC)
sys.modules[_LOCK_SPEC.name] = lock_projection
exec(compile(_LOCK_PATH.read_bytes(), str(_LOCK_PATH), "exec", dont_inherit=True), lock_projection.__dict__)

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*\Z")
_PACKAGE_SPEC = re.compile(r"([A-Za-z0-9][A-Za-z0-9_-]*)(?:[@:][0-9][A-Za-z0-9.+-]*)?\Z")
_DEPENDENCY_FIELDS = {
    "version", "registry", "registry-index", "path", "git", "branch", "tag",
    "rev", "package", "default-features", "features", "optional", "workspace",
    "public", "artifact", "lib", "target",
}
_STRING_FIELDS = {"version", "registry", "registry-index", "path", "git", "branch", "tag", "rev", "package", "target"}
_BOOL_FIELDS = {"default-features", "optional", "workspace", "public", "lib"}
_DEP_TABLES = (
    "dependencies", "dev-dependencies", "build-dependencies",
    "dev_dependencies", "build_dependencies",
)


class ProjectionError(ValueError):
    """Malformed or unsupported inputs must not look unchanged."""


def _table(value, label):
    if not isinstance(value, dict):
        raise ProjectionError(f"{label} must be a table")
    return value


def _dependency(value, label):
    if isinstance(value, str):
        if not value:
            raise ProjectionError(f"{label} has an empty dependency")
        return
    _table(value, label)
    unknown = set(value) - _DEPENDENCY_FIELDS
    if unknown:
        raise ProjectionError(f"{label} has unsupported dependency fields")
    for key in _STRING_FIELDS & value.keys():
        if not isinstance(value[key], str) or not value[key]:
            raise ProjectionError(f"{label}.{key} must be a nonempty string")
    for key in _BOOL_FIELDS & value.keys():
        if type(value[key]) is not bool:
            raise ProjectionError(f"{label}.{key} must be a boolean")
    if "features" in value and (
        not isinstance(value["features"], list)
        or any(not isinstance(item, str) or not item for item in value["features"])
    ):
        raise ProjectionError(f"{label}.features must be an array of strings")
    if "artifact" in value and not (
        (isinstance(value["artifact"], str) and value["artifact"])
        or (isinstance(value["artifact"], list) and all(isinstance(item, str) and item for item in value["artifact"]))
    ):
        raise ProjectionError(f"{label}.artifact is malformed")
    if "workspace" in value and value["workspace"] is not True:
        raise ProjectionError(f"{label}.workspace must be true")


def _inherited_dependencies(package):
    inherited = set()
    sections = [("package", package)]
    targets = package.get("target", {})
    for target, value in _table(targets, "target").items():
        sections.append((f"target.{target}", _table(value, f"target.{target}")))
    for label, section in sections:
        for modern, legacy in (("dev-dependencies", "dev_dependencies"),
                               ("build-dependencies", "build_dependencies")):
            if modern in section and legacy in section:
                raise ProjectionError(f"{label} has duplicate dependency table forms")
        for name in _DEP_TABLES:
            for key, value in _table(section.get(name, {}), f"{label}.{name}").items():
                if not isinstance(key, str) or not _NAME.fullmatch(key):
                    raise ProjectionError(f"{label}.{name} has an invalid dependency key")
                _dependency(value, f"{label}.{name}.{key}")
                if isinstance(value, dict) and value.get("workspace") is True:
                    inherited.add(key)
    return inherited


def _inherited_package_fields(package):
    fields = set()
    for key, value in _table(package.get("package"), "package").items():
        if isinstance(value, dict) and "workspace" in value:
            if value != {"workspace": True}:
                raise ProjectionError(f"package.{key} has malformed workspace inheritance")
            fields.add(key)
    return fields


def _paths(value, label, package_dir):
    if not isinstance(value, list):
        raise ProjectionError(f"{label} must be an array")
    found = False
    for path in value:
        if not isinstance(path, str) or not path or any(ch in path for ch in "*?[]{}\\"):
            raise ProjectionError(f"{label} has an unsupported member path")
        parts = PurePosixPath(path)
        if parts.is_absolute() or ".." in parts.parts:
            raise ProjectionError(f"{label} has an unsafe member path")
        if str(parts) == package_dir:
            found = True
    return found


def _package_name(spec):
    if not isinstance(spec, str):
        raise ProjectionError("Cargo package override is not a string")
    match = _PACKAGE_SPEC.fullmatch(spec)
    if not match:
        raise ProjectionError(f"unsupported Cargo package override: {spec}")
    return match.group(1)


def _filtered_patches(patches, reachable):
    result = {}
    for registry, entries in _table(patches, "patch").items():
        selected = {}
        for alias, value in _table(entries, f"patch.{registry}").items():
            if not isinstance(alias, str) or not _NAME.fullmatch(alias):
                raise ProjectionError("invalid patch dependency key")
            _dependency(value, f"patch.{registry}.{alias}")
            name = value.get("package", alias) if isinstance(value, dict) else alias
            if name in reachable:
                selected[alias] = value
        if selected:
            result[registry] = selected
    return result


def _filtered_profiles(profiles, reachable):
    result = deepcopy(_table(profiles, "profile"))
    for name, profile in result.items():
        _table(profile, f"profile.{name}")
        if "package" in profile:
            overrides = _table(profile["package"], f"profile.{name}.package")
            selected = {}
            for spec, value in overrides.items():
                _table(value, f"profile.{name}.package.{spec}")
                if spec == "*" or _package_name(spec) in reachable:
                    selected[spec] = value
            profile["package"] = selected
            if not profile["package"]:
                del profile["package"]
    return {name: profile for name, profile in result.items() if profile}


def project(workspace_document, package_document, graph, root, package_dir, extra_reachable=()):
    workspace_document = _table(workspace_document, "root manifest")
    package_document = _table(package_document, "package manifest")
    package = _table(package_document.get("package"), "package")
    if package.get("name") != root:
        raise ProjectionError("package name does not match lock projection root")
    closure = graph.projection(root)
    local_dependencies = {entry[0].name for entry in closure if not entry[0].source} - {root}
    if local_dependencies:
        raise ProjectionError("workspace path dependencies need explicit source and manifest coverage")
    reachable = {entry[0].name for entry in closure} | set(extra_reachable)
    projected = deepcopy(workspace_document)
    workspace = _table(projected.get("workspace"), "workspace")
    inherited = _inherited_dependencies(package_document)
    dependencies = _table(workspace.get("dependencies", {}), "workspace.dependencies")
    for key, value in dependencies.items():
        if not isinstance(key, str) or not _NAME.fullmatch(key):
            raise ProjectionError("invalid workspace dependency key")
        _dependency(value, f"workspace.dependencies.{key}")
        if isinstance(value, dict) and "workspace" in value:
            raise ProjectionError("workspace dependencies cannot inherit from themselves")
    if not inherited <= dependencies.keys():
        raise ProjectionError("an inherited workspace dependency is missing")
    workspace["dependencies"] = {key: dependencies[key] for key in sorted(inherited)}
    package_fields = _inherited_package_fields(package_document)
    shared_package = _table(workspace.get("package", {}), "workspace.package")
    if not package_fields <= shared_package.keys():
        raise ProjectionError("an inherited workspace package field is missing")
    workspace["package"] = {key: shared_package[key] for key in sorted(package_fields)}
    lints = _table(package_document.get("lints", {}), "lints")
    if "workspace" in lints and type(lints["workspace"]) is not bool:
        raise ProjectionError("lints.workspace must be a boolean")
    if not lints.get("workspace", False):
        workspace.pop("lints", None)
    elif "lints" not in workspace:
        raise ProjectionError("inherited workspace lints are missing")
    for field in ("members", "exclude", "default-members"):
        if field in workspace:
            workspace[field] = _paths(workspace[field], f"workspace.{field}", package_dir)
    workspace.pop("metadata", None)
    if "patch" in projected:
        projected["patch"] = _filtered_patches(projected["patch"], reachable)
        if not projected["patch"]:
            del projected["patch"]
    if "replace" in projected:
        replacement = {}
        for key, value in _table(projected["replace"], "replace").items():
            _dependency(value, f"replace.{key}")
            if _package_name(key) in reachable:
                replacement[key] = value
        projected["replace"] = replacement
        if not projected["replace"]:
            del projected["replace"]
    if "profile" in projected:
        projected["profile"] = _filtered_profiles(projected["profile"], reachable)
        if not projected["profile"]:
            del projected["profile"]
    return projected


def read_toml(path):
    try:
        with path.open("rb") as stream:
            return tomllib.load(stream)
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise ProjectionError(f"cannot read {path}: {exc}") from exc


def digest(document):
    try:
        encoded = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProjectionError(f"unsupported manifest value: {exc}") from exc
    return hashlib.sha256(encoded).hexdigest()


def read_projection(workspace_path, package_path, lock_path, root, package_dir):
    return project(read_toml(workspace_path), read_toml(package_path),
                   lock_projection.read_lock(lock_path), root, package_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--package-dir", required=True)
    parser.add_argument("before_workspace", type=Path)
    parser.add_argument("before_package", type=Path)
    parser.add_argument("before_lock", type=Path)
    parser.add_argument("after_workspace", type=Path)
    parser.add_argument("after_package", type=Path)
    parser.add_argument("after_lock", type=Path)
    args = parser.parse_args()
    try:
        before_graph = lock_projection.read_lock(args.before_lock)
        after_graph = lock_projection.read_lock(args.after_lock)
        reachable = {entry[0].name for graph in (before_graph, after_graph) for entry in graph.projection(args.root)}
        before = project(read_toml(args.before_workspace), read_toml(args.before_package), before_graph, args.root, args.package_dir, reachable)
        after = project(read_toml(args.after_workspace), read_toml(args.after_package), after_graph, args.root, args.package_dir, reachable)
        changed = digest(before) != digest(after)
    except (ProjectionError, lock_projection.LockError) as exc:
        print(f"cargo-workspace-projection: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"changed": changed}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
