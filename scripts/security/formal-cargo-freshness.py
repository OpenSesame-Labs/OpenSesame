#!/usr/bin/env python3
"""Require fresh local Cargo artifacts with a reviewed wrapper and input checker.

Assumes trusted Cargo/rustc and no concurrent source or target-cache writes.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import tomllib


class FreshnessError(ValueError):
    """Inputs or Cargo artifacts cannot establish the claimed fresh build."""

def scratch_fds(env: dict[str, str]) -> tuple[int, ...]:
    raw = env.get("OPENSESAME_FORMAL_SCRATCH_LOCK_FD")
    if raw is None: return ()
    if not raw.isdecimal() or int(raw) < 3 or not stat.S_ISREG(os.fstat(int(raw)).st_mode):
        raise FreshnessError("invalid scratch lock descriptor")
    return (int(raw),)


def command_env() -> dict[str, str]:
    env = os.environ.copy()
    env["RUSTC_WRAPPER"] = ""
    env["CARGO_INCREMENTAL"] = "0"
    env.pop("OPENSESAME_FORMAL_RUSTC_LOG", None)
    if not env.get("RUSTC_WORKSPACE_WRAPPER"):
        raise FreshnessError("reviewed RUSTC_WORKSPACE_WRAPPER is required")
    return env


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


def private_state(path: Path, create: bool = False) -> int:
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise FreshnessError("private freshness state is unsupported on this platform")
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise FreshnessError("freshness state directory must be private and owned by the caller")
    flags = os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT | os.O_EXCL if create else 0)
    fd = os.open(path, flags, 0o600)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
            info.st_mode & 0o077 or info.st_nlink != 1):
        os.close(fd)
        raise FreshnessError("freshness state must be a private regular file")
    return fd


def save_state(path: Path, state: dict, create: bool = False) -> None:
    fd = private_state(path, create=create)
    os.ftruncate(fd, 0)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(state, output)


def read_state(path: Path) -> dict:
    fd = private_state(path)
    with os.fdopen(fd, encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise FreshnessError("freshness state is not an object")
    return value


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


def artifact_key(message: dict) -> str:
    target = message.get("target")
    if not isinstance(target, dict) or not isinstance(message.get("fresh"), bool):
        raise FreshnessError("malformed local compiler artifact")
    fields = {
        "package_id": message.get("package_id"),
        "target": target,
        "profile": message.get("profile"),
        "features": message.get("features"),
        "filenames": message.get("filenames"),
        "executable": message.get("executable"),
    }
    if not isinstance(fields["filenames"], list) or not isinstance(fields["features"], list):
        raise FreshnessError("incomplete local compiler artifact")
    return json.dumps(fields, sort_keys=True, separators=(",", ":"))


def cargo_arguments(args: list[str], state: dict) -> tuple[list[str], list[str]]:
    if not args or args[0] not in ("test", "run"):
        raise FreshnessError("only cargo test and cargo run are supported")
    kind = args[0]
    before, separator, after = args[1:], [], []
    if "--" in before:
        index = before.index("--")
        before, separator, after = before[:index], ["--"], before[index + 1:]
    flags = {"--locked", "--offline", "--all-features", "--no-default-features",
             "--lib", "--quiet", "-q", "--release"}
    values = {"-p", "--package", "--manifest-path", "--test", "--bin", "--example",
              "--features", "--target", "--profile"}
    index = 0
    filters = 0
    specified_manifest = None
    while index < len(before):
        item = before[index]
        if item in values:
            index += 1
            if index == len(before) or before[index].startswith("-"):
                raise FreshnessError(f"missing Cargo option value: {item}")
            if item == "--manifest-path":
                if specified_manifest is not None:
                    raise FreshnessError("multiple Cargo manifests are unsupported")
                specified_manifest = str(regular_inside(Path(state["root"]), before[index]))
            if item in ("-p", "--package") and before[index] not in state["roots"]:
                raise FreshnessError(f"unreviewed root package: {before[index]}")
        elif item not in flags:
            if kind != "test" or item.startswith("-") or filters:
                raise FreshnessError(f"unsupported Cargo argument: {item}")
            filters += 1
        index += 1
    if "--locked" not in before:
        raise FreshnessError("formal Cargo commands must use --locked")
    default_manifest = str(Path(state["root"]) / "Cargo.toml")
    if (specified_manifest or default_manifest) != state["manifest"]:
        raise FreshnessError("Cargo command uses a different manifest than its freshness session")
    build_kind = "test" if kind == "test" else "build"
    build = ["cargo", build_kind, "--message-format=json"]
    if kind == "test":
        build.append("--no-run")
    build.extend(before)
    execute = ["cargo", kind, "--message-format=json", *before, *separator, *after]
    return build, execute


def cargo_run(command: list[str], root: Path, env: dict[str, str], state: dict,
              preflight: bool) -> int:
    process = subprocess.Popen(command, cwd=root, env=env, text=True, stdout=subprocess.PIPE,
                               stderr=None, bufsize=1, start_new_session=(os.name == "posix"),
                               pass_fds=scratch_fds(env))
    assert process.stdout is not None
    error: BaseException | None = None
    finished = False
    local_count = 0
    compiled_workspace: set[str] = set()
    try:
        for line in process.stdout:
            if finished:
                if not preflight:
                    print(line, end="", flush=True)
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                if not preflight:
                    print(line, end="", flush=True)
                continue
            if not isinstance(message, dict):
                if not preflight:
                    print(line, end="", flush=True)
                continue
            reason = message.get("reason")
            if reason == "compiler-artifact":
                package = message.get("package_id")
                local = state["packages"].get(package)
                if local is None:
                    if isinstance(package, str) and package.startswith("path+"):
                        raise FreshnessError(f"unreviewed local Cargo artifact: {package}")
                    continue
                local_count += 1
                key = artifact_key(message)
                if preflight:
                    if message["fresh"] and key not in state["seen"]:
                        raise FreshnessError(f"local artifact was not rebuilt in this proof: {package}")
                    if not message["fresh"]:
                        if key not in state["seen"]:
                            state["seen"].append(key)
                        if local["workspace"]:
                            name = message["target"].get("name")
                            if not isinstance(name, str) or not name:
                                raise FreshnessError("local compiler target has no name")
                            compiled_workspace.add(name.replace("-", "_"))
                elif not message["fresh"] or key not in state["seen"]:
                    raise FreshnessError(f"local artifact changed after no-run verification: {package}")
            elif reason == "compiler-message":
                diagnostic = message.get("message")
                if not isinstance(diagnostic, dict):
                    raise FreshnessError("malformed compiler diagnostic")
                rendered = diagnostic.get("rendered")
                if rendered:
                    print(rendered, end="", file=sys.stderr, flush=True)
            elif reason == "build-finished":
                if message.get("success") is not True:
                    raise FreshnessError("Cargo did not finish its build successfully")
                finished = True
            elif reason != "build-script-executed" and not preflight:
                print(line, end="", flush=True)
    except BaseException as exc:
        error = exc
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            pass
    finally:
        process.stdout.close()
    try:
        status = process.wait(timeout=5 if error else None)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        status = process.wait()
    if error:
        raise error
    if status and preflight:
        raise FreshnessError(f"Cargo command exited {status}")
    if not finished or not local_count:
        raise FreshnessError("Cargo omitted its successful build or local artifacts")
    if preflight and compiled_workspace:
        log = Path(env["OPENSESAME_FORMAL_RUSTC_LOG"])
        observed = set(log.read_text().splitlines()) if log.exists() else set()
        if not compiled_workspace <= observed:
            raise FreshnessError("workspace compiler wrapper did not observe every rebuilt target")
    return status if status >= 0 else 128 - status


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init")
    init.add_argument("--repo", type=Path, required=True)
    init.add_argument("--manifest", type=Path, required=True)
    init.add_argument("--state", type=Path, required=True)
    init.add_argument("--package", action="append", required=True)
    init.add_argument("--reviewed-patch", action="append", default=[], metavar="NAME=PATH",
                      help="path patch covered by the suite's reviewed sources, "
                           "with PATH relative to the repository root")
    run = sub.add_parser("run")
    run.add_argument("--state", type=Path, required=True)
    run.add_argument("--input-check", type=Path, required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    env = command_env()
    if options.action == "init":
        root = options.repo.resolve(strict=True)
        manifest = regular_inside(root, options.manifest)
        reviewed: dict[str, str] = {}
        for item in options.reviewed_patch:
            patched, separator, patch_path = item.partition("=")
            if not separator or not patched or not patch_path or patched in reviewed:
                raise SystemExit(f"malformed --reviewed-patch declaration: {item}")
            reviewed[patched] = patch_path
        packages = local_packages(root, manifest, options.package, env, reviewed)
        save_state(options.state, {
            "root": str(root), "manifest": str(manifest), "roots": options.package,
            "packages": packages, "seen": [],
            "reviewed_patches": sorted(f"{name}={path}" for name, path in reviewed.items()),
        }, create=True)
        print(f"formal Cargo freshness: prepared {len(packages)} local packages")
        return
    state = read_state(options.state)
    root = Path(state["root"])
    check = regular_inside(root, options.input_check)
    args = options.command[1:] if options.command[:1] == ["--"] else options.command
    build, execute = cargo_arguments(args, state)
    with tempfile.TemporaryDirectory(prefix="opensesame-formal-rustc-log-") as directory:
        env["OPENSESAME_FORMAL_RUSTC_LOG"] = str(Path(directory) / "rustc.log")
        subprocess.run([sys.executable, "-I", str(check)], cwd=root, env=env, check=True, timeout=60, pass_fds=scratch_fds(env))
        cargo_run(build, root, env, state, preflight=True)
        subprocess.run([sys.executable, "-I", str(check)], cwd=root, env=env, check=True, timeout=60, pass_fds=scratch_fds(env))
        try:
            status = cargo_run(execute, root, env, state, preflight=False)
        finally:
            subprocess.run([sys.executable, "-I", str(check)], cwd=root, env=env, check=True, timeout=60, pass_fds=scratch_fds(env))
    save_state(options.state, state)
    if status:
        raise SystemExit(status)


if __name__ == "__main__":
    def interrupted(_signum: int, _frame: object) -> None:
        raise InterruptedError("formal Cargo freshness interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"formal Cargo freshness: {error}", file=sys.stderr)
        sys.exit(1)
