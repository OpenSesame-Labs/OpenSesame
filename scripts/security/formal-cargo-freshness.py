#!/usr/bin/env python3
"""Require fresh local Cargo artifacts with a reviewed wrapper and input checker.

Assumes trusted Cargo/rustc and no concurrent source or target-cache writes.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile


def _packages_helper():
    # Load the reviewed sibling by path; never search sys.path or the CWD.
    path = Path(__file__).resolve().with_name("formal_cargo_packages.py")
    spec = importlib.util.spec_from_file_location("formal_cargo_packages", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"formal Cargo package helper unavailable: {path}")
    module = importlib.util.module_from_spec(spec)
    # Execute the reviewed bytes themselves, never a cached bytecode file.
    exec(compile(path.read_bytes(), str(path), "exec", dont_inherit=True), module.__dict__)
    return module


_packages = _packages_helper()
FreshnessError = _packages.FreshnessError
scratch_fds = _packages.scratch_fds
regular_inside = _packages.regular_inside
metadata = _packages.metadata
local_packages = _packages.local_packages


def command_env() -> dict[str, str]:
    env = os.environ.copy()
    env["RUSTC_WRAPPER"] = ""
    env["CARGO_INCREMENTAL"] = "0"
    env.pop("OPENSESAME_FORMAL_RUSTC_LOG", None)
    if not env.get("RUSTC_WORKSPACE_WRAPPER"):
        raise FreshnessError("reviewed RUSTC_WORKSPACE_WRAPPER is required")
    return env


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
