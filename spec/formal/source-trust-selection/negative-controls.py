#!/usr/bin/env python3
"""Test selector correspondence and runner guards against scratch mutations."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SELECTOR = Path("crates/gateway/src/transport/source_trust_selection.rs")
CORRESPONDENCE = "transport::boot::source_trust_selection::formal::lean_vectors_match_source_trust_selection"
EXACT = "transport::boot::source_trust_selection::formal::returns_exact_requested_source_bundle"


def scratch_path(base: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise RuntimeError("invalid scratch path")
    relative = Path(name)
    if relative.is_absolute() or str(relative) != name or any(p in (".", "..") for p in relative.parts):
        raise RuntimeError(f"invalid scratch path: {name}")
    current = base
    for part in relative.parts[:-1]:
        current /= part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise RuntimeError(f"unsafe scratch parent: {name}")
    return base / relative


def run(command: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=600, check=False)


def archive(destination: Path) -> None:
    staged = subprocess.run(["git", "diff", "--cached", "--quiet", "--"], cwd=ROOT, check=False)
    if staged.returncode == 1:
        raise RuntimeError("scratch controls require an empty index")
    if staged.returncode != 0:
        raise RuntimeError("could not inspect the Git index")
    proc = subprocess.Popen(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None and proc.stderr is not None
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as source:
            source.extractall(destination, filter="data")
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        proc.stdout.close()
    error = proc.stderr.read().decode("utf-8", errors="replace")
    if proc.wait() != 0:
        raise RuntimeError(f"git archive failed: {error}")
    suite = Path("spec/formal/source-trust-selection")
    coverage = scratch_path(ROOT, str(suite / "coverage.json"))
    if coverage.is_symlink() or not coverage.is_file():
        raise RuntimeError("unreviewed scratch coverage path")
    manifest = json.loads(coverage.read_text())
    paths = [entry["path"] for entry in manifest["sources"] + manifest["optional_sources"]]
    paths += ["Cargo.lock", "rust-toolchain.toml", "spec/formal/check-axioms.sh",
              "spec/formal/required-theorem-command.lean"]
    for command in (["git", "diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
                    ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        names = subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout.split(b"\0")
        paths.extend(os.fsdecode(name) for name in names if name)
    for name in dict.fromkeys(paths):
        source = scratch_path(ROOT, name)
        target = scratch_path(destination, name)
        if source.is_symlink():
            raise RuntimeError(f"unexpected symlink in {name}")
        if not source.exists():
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                raise RuntimeError(f"unexpected scratch target in {name}")
            continue
        if not source.is_file() or target.is_symlink():
            raise RuntimeError(f"unexpected scratch source in {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def require_pass(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(f"{label}: failed ({result.returncode})\n{(result.stdout + result.stderr)[-6000:]}")
    print(f"{label}: passed", flush=True)


def require_failure(result: subprocess.CompletedProcess[str], test: str, diagnostic: str, label: str) -> None:
    output = result.stdout + result.stderr
    if not (result.returncode == 101 and f"test {test} ... FAILED" in output and diagnostic in output):
        raise RuntimeError(f"{label}: unexpected result ({result.returncode})\n{output[-6000:]}")
    print(f"{label}: rejected", flush=True)


def cargo_test(scratch: Path, env: dict[str, str], name: str, ignored: bool = False) -> subprocess.CompletedProcess[str]:
    command = ["cargo", "test", "--locked", "-p", "opensesame-gateway", "--lib", name, "--"]
    if ignored:
        command.append("--ignored")
    command.append("--exact")
    return run(command, scratch, env)


def main() -> None:
    env = os.environ.copy() | {"CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"}
    lean = env.get("OPENSESAME_LEAN_BIN", "lean")
    if shutil.which("cargo") is None or shutil.which(lean) is None:
        raise RuntimeError("activate the pinned Rust and Lean toolchains first")
    require_pass(run([sys.executable, "-I", str(ROOT / "spec/formal/source-trust-selection/test_snapshot.py")], ROOT, env),
                 "scratch snapshot controls")
    original_hash = hashlib.sha256((ROOT / SELECTOR).read_bytes()).hexdigest()
    try:
        with tempfile.TemporaryDirectory(prefix="opensesame-selection-negative-") as directory:
            scratch = Path(directory)
            archive(scratch)
            require_pass(run(["bash", "spec/formal/source-trust-selection/verify.sh"], scratch, env),
                         "unmodified suite")
            result = run(["bash", "spec/formal/check-axioms.sh", lean,
                          str(scratch / "spec/formal/source-trust-selection/SourceTrustSelection.lean")], scratch, env)
            require_pass(result, "vector generation")
            vectors = scratch / "vectors.tsv"
            vectors.write_text(result.stdout)
            test_env = env | {"OPENSESAME_SOURCE_SELECTION_VECTORS": str(vectors)}
            target = scratch / SELECTOR
            original = target.read_text()
            mutations = [
                ("wrong source entry", ".get(profile)", ".values().next()", EXACT, False, "TrustUnknown"),
                ("wrong kind accepted", "kind == TrustProfileKind::SpiffeTrustDomain", "true", CORRESPONDENCE, True, "selector predicate"),
                ("wrong profile accepted", "actual_profile == profile", "true", CORRESPONDENCE, True, "selector predicate"),
                ("stale source hidden", "source?", "source.unwrap_or_default()", CORRESPONDENCE, True, "GenerationStale"),
            ]
            for label, before, after, name, ignored, diagnostic in mutations:
                if original.count(before) != 1:
                    raise RuntimeError(f"{label}: mutation target is not unique")
                try:
                    target.write_text(original.replace(before, after, 1))
                    require_failure(cargo_test(scratch, test_env, name, ignored), name, diagnostic, label)
                finally:
                    target.write_text(original)
            vectors.write_text("")
            require_failure(cargo_test(scratch, test_env, CORRESPONDENCE, True), CORRESPONDENCE,
                            "incomplete selector vector matrix", "empty vector matrix")
            fake_bin = scratch / "fake-bin"
            fake_bin.mkdir()
            fake = fake_bin / "cargo"
            fake.write_text("#!/bin/sh\nprintf 'running 0 tests\\n\\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\\n'\n")
            fake.chmod(0o755)
            zero_env = env | {"PATH": f"{fake_bin}{os.pathsep}{env['PATH']}"}
            zero = run(["bash", "spec/formal/source-trust-selection/verify.sh"], scratch, zero_env)
            if zero.returncode == 0 or "required selector correspondence did not run and pass" not in zero.stderr:
                raise RuntimeError(f"zero-test control not rejected\n{zero.stdout}\n{zero.stderr}")
            print("zero-test runner result: rejected", flush=True)
            require_pass(run(["bash", "spec/formal/source-trust-selection/verify.sh"], scratch, env),
                         "restored suite")
    finally:
        if hashlib.sha256((ROOT / SELECTOR).read_bytes()).hexdigest() != original_hash:
            raise RuntimeError("live selector changed while scratch controls ran")
    print("four implementation mutants, empty vectors, and a zero-test result rejected", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"source-trust-selection-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
