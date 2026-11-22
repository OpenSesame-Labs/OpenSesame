"""Resolve the local Cargo packages a formal freshness session must track.

Loaded by formal-cargo-freshness.py from its own directory. It owns Cargo
metadata, repository path checks, and reviewed local path-patch resolution.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import tomllib


class FreshnessError(ValueError):
    """Inputs or Cargo artifacts cannot establish the claimed fresh build."""

def scratch_fds(env: dict[str, str]) -> tuple[int, ...]:
    raw = env.get("OPENSESAME_FORMAL_SCRATCH_LOCK_FD")
    if raw is None: return ()
    if not raw.isdecimal() or int(raw) < 3 or not stat.S_ISREG(os.fstat(int(raw)).st_mode):
        raise FreshnessError("invalid scratch lock descriptor")
    return (int(raw),)


def regular_inside(root: Path, value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise FreshnessError(f"path outside reviewed repository: {path}") from exc
    if not relative.parts or any(part in (".", "..") for part in relative.parts):
        raise FreshnessError(f"invalid repository path: {path}")
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        mode = current.lstat().st_mode
        if not (stat.S_ISREG(mode) if index == len(relative.parts) - 1 else stat.S_ISDIR(mode)):
            raise FreshnessError(f"path is not a regular file: {path}")
    return current


def metadata(root: Path, manifest: Path, env: dict[str, str], dependencies: bool = False) -> dict:
    command = ["cargo", "metadata", "--locked",
               "--format-version", "1", "--manifest-path", str(manifest)]
    if not dependencies:
        command.append("--no-deps")
    result = subprocess.run(
        command,
        cwd=root, env=env, text=True, capture_output=True, check=False, timeout=60, pass_fds=scratch_fds(env),
    )
    if result.returncode:
        raise FreshnessError(f"Cargo metadata failed: {result.stderr[-4000:]}")
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or not isinstance(value.get("packages"), list):
        raise FreshnessError("Cargo metadata has no package list")
    return value


def local_packages(root: Path, manifest: Path, names: list[str], env: dict[str, str],
                   reviewed_patches: dict[str, str] | None = None) -> dict:
    packages: dict[str, dict] = {}
    workspaces: set[str] = set()
    declared = dict(reviewed_patches or {})
    observed: dict[str, dict[str, str]] = {}

    def load(path: Path) -> None:
        value = metadata(root, path, env)
        workspace_root = value.get("workspace_root")
        if not isinstance(workspace_root, str):
            raise FreshnessError("Cargo metadata has no workspace root")
        workspace_manifest = regular_inside(root, Path(workspace_root) / "Cargo.toml")
        document = tomllib.loads(workspace_manifest.read_text())
        patches = document.get("patch", {})
        replacements = document.get("replace", {})
        if not isinstance(patches, dict) or not isinstance(replacements, dict):
            raise FreshnessError("malformed Cargo patch or replacement table")
        for entries in [*patches.values(), replacements]:
            if not isinstance(entries, dict):
                raise FreshnessError("malformed Cargo patch entries")
            for patched, item in entries.items():
                if isinstance(item, dict) and "path" in item:
                    # Record path patches now; once the selected closure is
                    # known, only patches that can affect this session's
                    # artifacts still require a reviewed declaration.
                    if not isinstance(item["path"], str):
                        raise FreshnessError("malformed Cargo patch path")
                    observed.setdefault(patched, {})[item["path"]] = str(workspace_manifest.parent)
        members = value.get("workspace_members")
        if not isinstance(members, list) or any(not isinstance(item, str) for item in members):
            raise FreshnessError("Cargo metadata has invalid workspace members")
        workspaces.update(members)
        for package in value["packages"]:
            if not isinstance(package, dict) or not isinstance(package.get("id"), str):
                raise FreshnessError("Cargo metadata has an invalid package")
            manifest_path = regular_inside(root, package["manifest_path"])
            key = str(manifest_path.parent)
            if key in packages and packages[key]["id"] != package["id"]:
                raise FreshnessError(f"ambiguous local package at {key}")
            packages[key] = package

    load(manifest)
    original_workspace = set(workspaces)
    roots = []
    for name in names:
        found = [package for package in packages.values() if package.get("name") == name]
        if len(found) != 1:
            raise FreshnessError(f"root package is absent or ambiguous: {name}")
        roots.append(found[0])
    selected: dict[str, dict] = {}
    referenced: set[str] = set()

    def adopt(package: dict, workspace: bool) -> None:
        package_id = package["id"]
        if package_id in selected:
            return
        if package.get("source") is not None:
            raise FreshnessError("a selected local package has a nonlocal source")
        targets = package.get("targets")
        if not isinstance(targets, list) or not isinstance(package.get("dependencies"), list):
            raise FreshnessError(f"invalid package metadata: {package_id}")
        selected[package_id] = {"name": package["name"], "workspace": workspace}
        for target in targets:
            if not isinstance(target, dict) or not isinstance(target.get("src_path"), str):
                raise FreshnessError(f"invalid local target: {package_id}")
            path = regular_inside(root, target["src_path"])
            os.utime(path, None, follow_symlinks=False)

    pending = roots[:]
    while pending:
        package = pending.pop()
        package_id = package["id"]
        if package_id in selected:
            continue
        dependencies = package.get("dependencies")
        adopt(package, workspace=package_id in original_workspace)
        for dependency in dependencies:
            if not isinstance(dependency, dict):
                raise FreshnessError(f"invalid local dependency: {package_id}")
            dependency_name = dependency.get("name")
            if isinstance(dependency_name, str):
                # Registry dependencies count: a workspace patch can redirect
                # them to local sources, which the artifact check must then
                # track like any other local package.
                referenced.add(dependency_name)
            path = dependency.get("path")
            if path is None:
                continue
            if not isinstance(path, str):
                raise FreshnessError(f"invalid dependency path: {package_id}")
            dependency_manifest = regular_inside(root, Path(path) / "Cargo.toml")
            key = str(dependency_manifest.parent)
            if key not in packages:
                load(dependency_manifest)
            if key not in packages:
                raise FreshnessError(f"local dependency not found by Cargo metadata: {key}")
            pending.append(packages[key])
    consumed: dict[str, str] = {}
    for patched, paths in sorted(observed.items()):
        if patched not in referenced:
            # A patch whose crate no selected package references cannot affect
            # this session's artifacts, so it needs no declaration here.
            continue
        accepted = declared.pop(patched, None)
        if accepted is None:
            raise FreshnessError(
                f"local Cargo patches require separately reviewed coverage: {patched}"
            )
        # The same patch can be declared by several workspace manifests with
        # different relative spellings; every observation must resolve to the
        # declared directory, anchored at the repository root.
        target = os.path.normpath(str(root / accepted))
        resolved = {os.path.normpath(str(Path(base) / path)) for path, base in paths.items()}
        if resolved != {target}:
            raise FreshnessError(
                f"local Cargo patches require separately reviewed coverage: {patched}"
            )
        consumed[patched] = target
    if declared:
        leftover = sorted(declared)[0]
        raise FreshnessError(
            f"reviewed patch declaration matches no in-scope path patch: {leftover}"
        )
    if consumed:
        # Adopt each declared patch as a tracked local package, using the full
        # resolution so the package id and targets are Cargo's own. A patched
        # manifest is not workspace metadata material, so it cannot be loaded
        # through the no-deps workspace walk above.
        resolved_packages = metadata(root, manifest, env, dependencies=True).get("packages", [])
        by_directory: dict[str, dict] = {}
        for package in resolved_packages:
            if isinstance(package, dict) and isinstance(package.get("manifest_path"), str):
                directory = os.path.normpath(str(Path(package["manifest_path"]).parent))
                by_directory.setdefault(directory, package)
        for patched, target in sorted(consumed.items()):
            package = by_directory.get(target)
            if package is None or package.get("name") != patched or not isinstance(package.get("id"), str):
                raise FreshnessError(f"reviewed patch manifest does not provide {patched}")
            adopt(package, workspace=False)
    return selected
