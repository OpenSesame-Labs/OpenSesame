#!/usr/bin/env python3
"""Create a private Cargo workspace-wrapper namespace for one checkout.

Cargo includes the workspace-wrapper path in workspace artifact hashes. Two
worktrees using the same CARGO_TARGET_DIR must therefore use distinct wrapper
paths. This helper does not authenticate compiled artifacts or replace the
separate source/freshness checks.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib

try:
    import fcntl
except ImportError:  # Non-POSIX platforms fail closed below.
    fcntl = None

SHIM = b'''#!/bin/sh
# Optional log is owned and initialized by the proof runner.
if [ -n "${OPENSESAME_FORMAL_RUSTC_LOG:-}" ]; then
  previous=
  for argument do
    if [ "$previous" = "--crate-name" ]; then
      printf '%s\\n' "$argument" >> "$OPENSESAME_FORMAL_RUSTC_LOG" || exit 1
      break
    fi
    previous=$argument
  done
fi
exec "$@"
'''


def private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError(f"wrapper directory is not private: {path}")


def lock_fds(env: dict[str, str]) -> tuple[int, ...]:
    raw = env.get("OPENSESAME_FORMAL_SCRATCH_LOCK_FD")
    if raw is None:
        return ()
    if not raw.isdecimal():
        raise ValueError("invalid scratch lock descriptor")
    fd = int(raw)
    if fd < 3 or not stat.S_ISREG(os.fstat(fd).st_mode):
        raise ValueError("scratch lock descriptor is not a regular file")
    return (fd,)


def rename_noreplace(source: Path, target: Path) -> None:
    """Move a staged directory without ever replacing an existing path."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            raise ValueError("safe scratch registration is unavailable")
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    elif sys.platform == "darwin":
        rename = getattr(libc, "renamex_np", None)
        if rename is None:
            raise ValueError("safe scratch registration is unavailable")
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(source), os.fsencode(target), 4)
    else:
        raise ValueError("safe scratch registration is unsupported on this platform")
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def scratch_record(parent: Path, key: str) -> tuple[Path, dict | None]:
    path = parent / f"{key}.json"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return path, None
    with os.fdopen(fd, "r", encoding="utf-8") as file:
        info = os.fstat(file.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError("scratch registration is not private")
        record = json.load(file)
    if (not isinstance(record, dict) or set(record) != {"version", "key", "stage", "device", "inode"} or
            record["version"] != 1 or record["key"] != key or
            not isinstance(record["stage"], str) or not record["stage"].startswith(f"{key}.stage-") or
            Path(record["stage"]).name != record["stage"] or
            type(record["device"]) is not int or type(record["inode"]) is not int):
        raise ValueError("invalid scratch registration")
    return path, record


def retire_scratch(parent: Path, key: str, expected: tuple[int, int] | None = None) -> None:
    record_path, record = scratch_record(parent, key)
    checkout = parent / f"{key}.checkout"
    if record is None:
        if checkout.exists() or checkout.is_symlink():
            raise ValueError("unregistered scratch path is present")
        return
    if expected is not None and (record["device"], record["inode"]) != expected:
        return
    stage = parent / record["stage"]
    present = [path for path in (stage, checkout) if path.exists() or path.is_symlink()]
    if len(present) > 1:
        raise ValueError("conflicting scratch paths are present")
    if present:
        info = present[0].lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o700 or
                (info.st_dev, info.st_ino) != (record["device"], record["inode"])):
            raise ValueError("scratch path does not match its registered inode")
        if not shutil.rmtree.avoids_symlink_attacks:
            raise ValueError("safe scratch cleanup is unavailable")
        shutil.rmtree(present[0])
    record_path.unlink()


class ScratchCheckout:
    def __init__(self, path: Path, lock_fd: int):
        self.path = path
        self.lock_fd = lock_fd


@contextmanager
def scratch_lock(root: Path, *, nonblocking: bool = False):
    if os.name != "posix" or fcntl is None or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("safe scratch locking is unsupported on this platform")
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspace root is not a directory")
    parent = Path(tempfile.gettempdir()) / f"opensesame-formal-scratch-{os.geteuid()}"
    private_directory(parent)
    key = hashlib.sha256(os.fsencode(root)).hexdigest()
    fd = os.open(parent / f"{key}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError("scratch lock is not private")
        os.set_inheritable(fd, True)
        fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield parent, key, fd
    finally:
        os.close(fd)


def cleanup_scratch(root: Path, *, nonblocking: bool = False,
                    expected: tuple[int, int] | None = None) -> None:
    """Retire only a registered checkout after all lease holders have exited."""
    with scratch_lock(root, nonblocking=nonblocking) as (parent, key, _):
        retire_scratch(parent, key, expected)


@contextmanager
def scratch_checkout(root: Path):
    """Lease one registered scratch checkout for a canonical live worktree."""
    owned = None
    try:
        with scratch_lock(root) as (parent, key, fd):
            retire_scratch(parent, key)
            stage = Path(tempfile.mkdtemp(prefix=f"{key}.stage-", dir=parent))
            stage.chmod(0o700)
            info = stage.lstat()
            record_path = parent / f"{key}.json"
            record = {"version": 1, "key": key, "stage": stage.name,
                      "device": info.st_dev, "inode": info.st_ino}
            record_fd, temporary = tempfile.mkstemp(prefix=f".{key}.record-", dir=parent)
            try:
                with os.fdopen(record_fd, "w", encoding="utf-8") as file:
                    os.fchmod(file.fileno(), 0o600)
                    json.dump(record, file)
                    file.flush()
                    os.fsync(file.fileno())
                rename_noreplace(Path(temporary), record_path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            checkout = parent / f"{key}.checkout"
            rename_noreplace(stage, checkout)
            owned = (info.st_dev, info.st_ino)
            yield ScratchCheckout(checkout, fd)
    finally:
        if owned is not None:
            try:
                cleanup_scratch(root, nonblocking=True, expected=owned)
            except BlockingIOError:
                pass


def wrapper_for(root: Path) -> Path:
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("private workspace wrappers are unsupported on this platform")
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspace root is not a directory")
    parent = Path(tempfile.gettempdir()) / f"opensesame-formal-cargo-{os.geteuid()}"
    private_directory(parent)
    key = hashlib.sha256(os.fsencode(root)).hexdigest()
    wrapper = parent / key
    # Publish a fully written shim atomically. An interrupted creator may
    # leave its private temporary file, but cannot leave a partial wrapper.
    fd, temporary = tempfile.mkstemp(prefix=".wrapper-", dir=parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as file:
            os.fchmod(file.fileno(), 0o700)
            file.write(SHIM)
            file.flush()
            os.fsync(file.fileno())
        try:
            os.link(temporary_path, wrapper, follow_symlinks=False)
        except FileExistsError:
            pass
    finally:
        temporary_path.unlink(missing_ok=True)
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open(wrapper, flags)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o700 or os.read(fd, len(SHIM) + 1) != SHIM):
            raise ValueError(f"workspace wrapper differs from the trusted shim: {wrapper}")
    finally:
        os.close(fd)
    return wrapper


def reviewed_file(root: Path, value: Path) -> tuple[Path, str]:
    path = Path(value)
    relative = path.relative_to(root) if path.is_absolute() else path
    if (not relative.parts or any(part in (".", "..") for part in relative.parts) or
            "\\" in str(relative) or any(ord(char) < 32 for char in str(relative))):
        raise ValueError("invalid scratch reviewed path")
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        mode = current.lstat().st_mode
        valid = stat.S_ISREG(mode) if index == len(relative.parts) - 1 else stat.S_ISDIR(mode)
        if not valid:
            raise ValueError("scratch reviewed path is not regular")
    return current, relative.as_posix()


def check_cargo_targets(root: Path, inventory: dict, covered_paths: set[str]) -> None:
    """Check only independently listed Cargo targets before executing Cargo."""
    root = root.resolve(strict=True)
    for manifest_name, expected in inventory.items():
        manifest, name = reviewed_file(root, Path(manifest_name))
        if name not in covered_paths or not isinstance(expected, dict):
            raise ValueError("Cargo target manifest is not covered")
        document = tomllib.loads(manifest.read_text())
        package = document.get("package")
        if not isinstance(package, dict) or package.get("name") != expected.get("package"):
            raise ValueError(f"unexpected Cargo package: {name}")
        build, script = package.get("build", "build.rs"), manifest.parent / "build.rs"
        if (build is not False and build != "build.rs") or script.exists() or script.is_symlink():
            raise ValueError(f"unreviewed Cargo build script or custom path: {name}")
        library = expected.get("lib")
        if library is not None:
            spec = document.get("lib", {})
            if (not isinstance(spec, dict) or set(spec) - {"name", "path"} or
                    package.get("autolib", True) is not True or
                    spec.get("name", package["name"].replace("-", "_")) != library[0] or
                    spec.get("path", "src/lib.rs") != library[1]):
                raise ValueError(f"reviewed Cargo lib target changed: {name}")
            target, target_name = reviewed_file(root, manifest.parent / library[1])
            if target_name not in covered_paths or not target.is_file():
                raise ValueError(f"Cargo lib target is not covered: {name}")
        for kind in ("bin", "test"):
            wanted = expected.get(kind, {})
            if not isinstance(wanted, dict):
                raise ValueError(f"malformed Cargo {kind} inventory: {name}")
            if not wanted:
                continue
            declarations = document.get(kind, [])
            if (not isinstance(declarations, list) or
                    any(not isinstance(item, dict) or not isinstance(item.get("name"), str) for item in declarations)):
                raise ValueError(f"malformed Cargo {kind} targets: {name}")
            for target_name, path in wanted.items():
                matches = [item for item in declarations if isinstance(item, dict) and item.get("name") == target_name]
                if len(matches) > 1 or (kind == "test" and package.get("autotests", True) is not True):
                    raise ValueError(f"ambiguous Cargo {kind} target: {name}:{target_name}")
                if matches:
                    entry = matches[0]
                    default = f"tests/{target_name}.rs" if kind == "test" else f"src/bin/{target_name}.rs"
                    if set(entry) - {"name", "path"} or entry.get("path", default) != path:
                        raise ValueError(f"reviewed Cargo {kind} target changed: {name}:{target_name}")
                elif kind != "test" or path != f"tests/{target_name}.rs":
                    raise ValueError(f"reviewed Cargo {kind} target missing: {name}:{target_name}")
                if kind == "test" and (not matches or "path" not in matches[0]):
                    alternate = manifest.parent / "tests" / target_name / "main.rs"
                    if alternate.exists() or alternate.is_symlink() or alternate.parent.is_symlink():
                        raise ValueError(f"ambiguous implicit Cargo test target: {name}:{target_name}")
                _, source_name = reviewed_file(root, manifest.parent / path)
                if source_name not in covered_paths:
                    raise ValueError(f"Cargo {kind} target is not covered: {name}:{target_name}")


@contextmanager
def mutated_coverage(root: Path, coverage_path: Path, source_path: Path,
                     before: str, after: str, checker: Path, section: str | None = None,
                     env: dict[str, str] | None = None):
    """Bind one declared scratch mutation to the reviewed inventory; the baseline checker runs first.
    Callers rerun that checker around the build; the scratch is restored even when the witness raises."""
    root = root.resolve(strict=True)
    coverage_file, _ = reviewed_file(root, coverage_path)
    source_file, source_name = reviewed_file(root, source_path)
    check_file, _ = reviewed_file(root, checker)
    if len({coverage_file, source_file, check_file}) != 3:
        raise ValueError("scratch source, coverage, and checker must be distinct")
    active_env = os.environ.copy() if env is None else env
    subprocess.run([sys.executable, "-I", str(check_file)], cwd=root, env=active_env,
                   check=True, pass_fds=lock_fds(active_env))
    original_source = source_file.read_bytes()
    original_coverage = coverage_file.read_bytes()
    old, new = before.encode(), after.encode()
    if not old or old == new or original_source.count(old) != 1:
        raise ValueError("scratch mutation must replace exactly one unique byte sequence")
    coverage = json.loads(original_coverage)
    inventory = coverage if section is None else coverage[section]
    matches = [entry for entry in inventory["sources"] if entry.get("path") == source_name]
    if len(matches) != 1 or matches[0].get("sha256") != hashlib.sha256(original_source).hexdigest():
        raise ValueError("scratch mutation source is not uniquely covered by the baseline")
    changed = original_source.replace(old, new, 1)
    matches[0]["sha256"] = hashlib.sha256(changed).hexdigest()
    if "reviewed_blob" in matches[0]:  # a blob-checking checker must find the mutant's bytes
        git_root = root if (root / ".git").exists() else Path(active_env["OPENSESAME_FORMAL_GIT_ROOT"])
        matches[0]["reviewed_blob"] = subprocess.run(["git", "-C", str(git_root), "hash-object", "-w", "--stdin"],
                                                     input=changed, capture_output=True, check=True).stdout.decode().strip()
    try:
        source_file.write_bytes(changed)
        coverage_file.write_text(json.dumps(coverage, indent=2) + "\n")
        yield
    finally:
        source_file.write_bytes(original_source)
        coverage_file.write_bytes(original_coverage)


def checked_cargo(root: Path, env: dict[str, str], packages: list[str], checker: Path, args: list[str],
                  timeout: int = 600, reviewed_patches: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
    """Run one scratch witness; `reviewed_patches` are the live runner's NAME=PATH patches."""
    root = root.resolve(strict=True)
    env = env.copy() | {"RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": str(wrapper_for(root))}
    env.pop("OPENSESAME_FORMAL_RUSTC_LOG", None)
    check_file, _ = reviewed_file(root, checker)
    validator, _ = reviewed_file(root, Path("scripts/security/formal-cargo-freshness.py"))
    fds = lock_fds(env)
    result = subprocess.run([sys.executable, "-I", str(check_file)], cwd=root, env=env,
                            text=True, capture_output=True, timeout=timeout, check=False, pass_fds=fds)
    if result.returncode:
        return result
    with tempfile.TemporaryDirectory(prefix="opensesame-formal-witness-") as directory:
        state = Path(directory) / "state.json"
        init = [sys.executable, "-I", str(validator), "init", "--repo", str(root),
                "--manifest", str(root / "Cargo.toml"), "--state", str(state)]
        init += [arg for package in packages for arg in ("--package", package)]
        init += [arg for patch in reviewed_patches for arg in ("--reviewed-patch", patch)]
        result = subprocess.run(init, cwd=root, env=env, text=True, capture_output=True,
                                timeout=timeout, check=False, pass_fds=fds)
        if result.returncode:
            return result
        return subprocess.run([sys.executable, "-I", str(validator), "run", "--state", str(state),
                               "--input-check", str(check_file), "--", *args], cwd=root, env=env,
                              text=True, capture_output=True, timeout=timeout, check=False, pass_fds=fds)


def main() -> None:
    if len(sys.argv) == 2:
        print(wrapper_for(Path(sys.argv[1])))
    elif len(sys.argv) == 3 and sys.argv[1] == "--clean-scratch":
        cleanup_scratch(Path(sys.argv[2]))
    else:
        raise ValueError("usage: formal-cargo-isolation.py [--clean-scratch] WORKSPACE_ROOT")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(f"formal-cargo-isolation: {error}") from error
