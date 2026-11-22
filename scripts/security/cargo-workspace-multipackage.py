#!/usr/bin/env python3
"""Project reviewed workspace inputs for a lock closure of local packages.

Manifest bytes come from a caller-supplied historical snapshot. This tool does
not execute Cargo, repository code, configuration, or historical manifests.
"""

from __future__ import annotations

from copy import deepcopy
import argparse
import importlib.util
import json
from pathlib import Path, PurePosixPath
import posixpath
import stat
import sys

sys.dont_write_bytecode = True
_PATH = Path(__file__).with_name("cargo-workspace-projection.py")
if not stat.S_ISREG(_PATH.lstat().st_mode):
    raise RuntimeError("Cargo workspace projection helper must be a regular file")
_SPEC = importlib.util.spec_from_file_location("cargo_workspace_projection", _PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("Cargo workspace projection helper is unavailable")
workspace_projection = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = workspace_projection
exec(compile(_PATH.read_bytes(), str(_PATH), "exec", dont_inherit=True), workspace_projection.__dict__)
lock_projection = workspace_projection.lock_projection
ProjectionError = workspace_projection.ProjectionError


def manifest_path(path):
    if (not isinstance(path, str) or not path.endswith("/Cargo.toml") or
            "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path)):
        raise ProjectionError("invalid local manifest path")
    parts = PurePosixPath(path)
    if parts.is_absolute() or any(part in ("", ".", "..") for part in path.split("/")):
        raise ProjectionError("unsafe local manifest path")
    return path


def resolved_path(base, path):
    if (not isinstance(path, str) or not path or path.startswith("/") or "\\" in path or
            any(ord(c) < 32 or ord(c) == 127 for c in path)):
        raise ProjectionError("invalid local dependency path")
    resolved = posixpath.normpath(posixpath.join(base, path))
    if resolved in (".", "..") or resolved.startswith("../"):
        raise ProjectionError("local dependency path escapes the workspace")
    return manifest_path(f"{resolved}/Cargo.toml")


def manifest_ancestors(paths):
    ancestors = set()
    for path in paths:
        parts = manifest_path(path).split("/")[:-1]
        ancestors.update("/".join(parts[:count]) + "/Cargo.toml" for count in range(1, len(parts)))
    return ancestors


def validate_workspace_root(path, document, package):
    if "workspace" in document:
        raise ProjectionError(f"nested workspace in {path} is unsupported")
    build = package.get("build", False)
    if build is not False and build != "build.rs":
        raise ProjectionError(f"custom or malformed package.build in {path} is unsupported")
    explicit = package.get("workspace")
    if explicit is None:
        return
    if (not isinstance(explicit, str) or not explicit or explicit.startswith("/") or
            "\\" in explicit or any(ord(c) < 32 or ord(c) == 127 for c in explicit)):
        raise ProjectionError(f"invalid package.workspace in {path}")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), explicit))
    if resolved != ".":
        raise ProjectionError(f"package.workspace in {path} points outside the reviewed root")


def package_version(package, workspace):
    value = package.get("version")
    if value == {"workspace": True}:
        value = workspace_projection._table(workspace.get("package", {}), "workspace.package").get("version")
    if not isinstance(value, str) or not lock_projection._version(value):
        raise ProjectionError("local package version is absent or unsupported")
    return value


def local_manifests(documents, graph, root, root_path, workspace):
    closure = graph.projection(root)
    local = [entry[0] for entry in closure if not entry[0].source]
    if len({identity.name for identity in local}) != len(local):
        raise ProjectionError("ambiguous local package names in lock closure")
    by_name = {identity.name: identity for identity in local}
    selected = {}
    for path, document in documents.items():
        manifest_path(path)
        if document is None:
            continue
        document = workspace_projection._table(document, path)
        package = workspace_projection._table(document.get("package"), f"{path}.package")
        name = package.get("name")
        if not isinstance(name, str) or not workspace_projection._NAME.fullmatch(name):
            raise ProjectionError(f"{path} has an invalid package name")
        if name not in by_name:
            continue
        validate_workspace_root(path, document, package)
        if name in selected or package_version(package, workspace) != by_name[name].version:
            raise ProjectionError(f"ambiguous or mismatched local manifest for {name}")
        selected[name] = (path, document)
    if set(selected) != set(by_name):
        raise ProjectionError("local lock closure lacks an exactly matching reviewed manifest set")
    if selected[root][0] != root_path:
        raise ProjectionError("root package does not match its reviewed manifest path")
    return closure, by_name, selected


def dependency_sections(document):
    targets = workspace_projection._table(document.get("target", {}), "target")
    return [document, *(workspace_projection._table(value, "target entry") for value in targets.values())]


def patched_paths(root_document):
    patches = {}
    for registry, entries in workspace_projection._table(root_document.get("patch", {}), "patch").items():
        for alias, value in workspace_projection._table(entries, f"patch.{registry}").items():
            workspace_projection._dependency(value, f"patch.{registry}.{alias}")
            if isinstance(value, dict) and "path" in value:
                name = value.get("package", alias)
                patches.setdefault(name, set()).add((registry, resolved_path("", value["path"])))
    for spec, value in workspace_projection._table(root_document.get("replace", {}), "replace").items():
        name = workspace_projection._package_name(spec)
        workspace_projection._dependency(value, f"replace.{spec}")
        if isinstance(value, dict) and "path" in value:
            patches.setdefault(name, set()).add(("unsupported-replace", resolved_path("", value["path"])))
    return patches


def validate_local_paths(root_document, workspace, graph, local, selected):
    workspace_dependencies = workspace_projection._table(workspace.get("dependencies", {}), "workspace.dependencies")
    patches = patched_paths(root_document)
    for name, (path, document) in selected.items():
        expected = {dependency.name for dependency in graph.edges[local[name]] if not dependency.source}
        actual = set()
        for section in dependency_sections(document):
            for kind in workspace_projection._DEP_TABLES:
                dependencies = workspace_projection._table(section.get(kind, {}), f"{path}.{kind}")
                for alias, value in dependencies.items():
                    if not isinstance(alias, str) or not workspace_projection._NAME.fullmatch(alias):
                        raise ProjectionError(f"invalid dependency alias in {path}")
                    workspace_projection._dependency(value, f"{path}.{kind}.{alias}")
                    inherited = isinstance(value, dict) and value.get("workspace") is True
                    if inherited and alias not in workspace_dependencies:
                        raise ProjectionError(f"inherited dependency {alias} is missing")
                    if inherited and set(value) - {"workspace", "features", "optional", "default-features"}:
                        raise ProjectionError(f"unsupported inherited dependency override {alias}")
                    effective = workspace_dependencies[alias] if inherited else value
                    workspace_projection._dependency(effective, f"dependency {alias}")
                    if isinstance(effective, dict):
                        sources = {key for key in ("path", "git", "registry", "registry-index") if key in effective}
                        if len(sources) > 1:
                            raise ProjectionError(f"conflicting dependency sources for {alias}")
                    explicit_name = value.get("package") if isinstance(value, dict) else None
                    shared_name = effective.get("package") if isinstance(effective, dict) else None
                    if explicit_name and shared_name and explicit_name != shared_name:
                        raise ProjectionError(f"conflicting package aliases for {alias}")
                    dependency_name = explicit_name or shared_name or alias
                    if isinstance(effective, dict) and "path" in effective:
                        base = "" if inherited else posixpath.dirname(path)
                        resolved = resolved_path(base, effective["path"])
                        if dependency_name not in expected or selected[dependency_name][0] != resolved:
                            raise ProjectionError(f"unreviewed or mismatched path dependency {alias} in {path}")
                        actual.add(dependency_name)
                    elif dependency_name in expected:
                        candidates = patches.get(dependency_name, set())
                        explicit_source = isinstance(effective, dict) and any(
                            key in effective for key in ("git", "registry", "registry-index")
                        )
                        if explicit_source or candidates != {("crates-io", selected[dependency_name][0])}:
                            raise ProjectionError(f"unresolved local patch dependency {alias} in {path}")
                        actual.add(dependency_name)
        if actual != expected:
            raise ProjectionError(f"local manifest dependencies disagree with lock graph for {name}")


def project(root_document, documents, graph, root, root_path, extra_reachable=()):
    root_document = workspace_projection._table(root_document, "root manifest")
    root_path = manifest_path(root_path)
    for ancestor in manifest_ancestors(documents):
        if ancestor not in documents:
            raise ProjectionError(f"missing ancestor manifest evidence for {ancestor}")
        if documents[ancestor] is not None:
            raise ProjectionError(f"nested workspace manifest {ancestor} is unsupported")
    workspace = workspace_projection._table(root_document.get("workspace"), "workspace")
    closure, local, selected = local_manifests(documents, graph, root, root_path, workspace)
    validate_local_paths(root_document, workspace, graph, local, selected)
    inherited = set()
    fields = set()
    inherit_lints = False
    for _, document in selected.values():
        inherited.update(workspace_projection._inherited_dependencies(document))
        fields.update(workspace_projection._inherited_package_fields(document))
        lints = workspace_projection._table(document.get("lints", {}), "lints")
        if "workspace" in lints and type(lints["workspace"]) is not bool:
            raise ProjectionError("lints.workspace must be a boolean")
        inherit_lints |= lints.get("workspace", False)
    result = deepcopy(root_document)
    projected = result["workspace"]
    dependencies = workspace_projection._table(projected.get("dependencies", {}), "workspace.dependencies")
    for alias, value in dependencies.items():
        if not isinstance(alias, str) or not workspace_projection._NAME.fullmatch(alias):
            raise ProjectionError("invalid workspace dependency key")
        workspace_projection._dependency(value, f"workspace.dependencies.{alias}")
        if isinstance(value, dict) and "workspace" in value:
            raise ProjectionError("workspace dependencies cannot inherit from themselves")
    if not inherited <= dependencies.keys():
        raise ProjectionError("an inherited workspace dependency is missing")
    projected["dependencies"] = {key: dependencies[key] for key in sorted(inherited)}
    shared_package = workspace_projection._table(projected.get("package", {}), "workspace.package")
    if not fields <= shared_package.keys():
        raise ProjectionError("an inherited workspace package field is missing")
    projected["package"] = {key: shared_package[key] for key in sorted(fields)}
    if inherit_lints:
        workspace_projection._table(projected.get("lints"), "workspace.lints")
    else:
        projected.pop("lints", None)
    dirs = sorted(posixpath.dirname(path) for path, _ in selected.values())
    for field in ("members", "exclude", "default-members"):
        if field in projected:
            projected[field] = {path: workspace_projection._paths(projected[field], f"workspace.{field}", path) for path in dirs}
    projected.pop("metadata", None)
    reachable = {entry[0].name for entry in closure} | set(extra_reachable)
    if "patch" in result:
        result["patch"] = workspace_projection._filtered_patches(result["patch"], reachable)
        if not result["patch"]:
            del result["patch"]
    if "replace" in result:
        replacement = {}
        for key, value in workspace_projection._table(result["replace"], "replace").items():
            workspace_projection._dependency(value, f"replace.{key}")
            if workspace_projection._package_name(key) in reachable:
                replacement[key] = value
        if replacement:
            result["replace"] = replacement
        else:
            del result["replace"]
    if "profile" in result:
        result["profile"] = workspace_projection._filtered_profiles(result["profile"], reachable)
        if not result["profile"]:
            del result["profile"]
    return result


def regular_file(path):
    try:
        if (not path.is_absolute() or path.resolve() != path or
                not stat.S_ISREG(path.lstat().st_mode)):
            raise ProjectionError("historical manifest blob is not a regular file")
    except OSError as exc:
        raise ProjectionError(f"cannot inspect historical manifest blob: {exc}") from exc
    return path


def unique_pairs(pairs):
    values = {}
    for key, value in pairs:
        if key in values:
            raise ProjectionError("duplicate historical manifest path")
        values[key] = value
    return values


def read_manifest_set(index):
    try:
        values = json.loads(regular_file(index).read_text(), object_pairs_hook=unique_pairs)
    except (OSError, ValueError) as exc:
        raise ProjectionError(f"cannot read historical manifest set: {exc}") from exc
    values = workspace_projection._table(values, "manifest set")
    documents = {}
    for path, filename in values.items():
        manifest_path(path)
        if filename is not None and not isinstance(filename, str):
            raise ProjectionError("invalid historical manifest blob path")
        documents[path] = None if filename is None else workspace_projection.read_toml(regular_file(Path(filename)))
    return documents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--root-manifest", required=True)
    parser.add_argument("--before-manifests", required=True, type=Path)
    parser.add_argument("--after-manifests", required=True, type=Path)
    parser.add_argument("before_workspace", type=Path)
    parser.add_argument("before_lock", type=Path)
    parser.add_argument("after_workspace", type=Path)
    parser.add_argument("after_lock", type=Path)
    args = parser.parse_args()
    try:
        before_graph = lock_projection.read_lock(args.before_lock)
        after_graph = lock_projection.read_lock(args.after_lock)
        reachable = {entry[0].name for graph in (before_graph, after_graph) for entry in graph.projection(args.root)}
        before = project(workspace_projection.read_toml(args.before_workspace), read_manifest_set(args.before_manifests), before_graph, args.root, args.root_manifest, reachable)
        after = project(workspace_projection.read_toml(args.after_workspace), read_manifest_set(args.after_manifests), after_graph, args.root, args.root_manifest, reachable)
        changed = workspace_projection.digest(before) != workspace_projection.digest(after)
    except (ProjectionError, lock_projection.LockError) as exc:
        print(f"cargo-workspace-multipackage: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"changed": changed}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
