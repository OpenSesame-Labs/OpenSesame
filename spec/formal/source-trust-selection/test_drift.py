#!/usr/bin/env python3
"""Exercise pre-Cargo drift and implicit build-script controls in scratch."""
from __future__ import annotations

import hashlib
import importlib._bootstrap_external
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SUITE = Path("spec/formal/source-trust-selection")


def copy_snapshot(target: Path) -> dict:
    coverage = json.loads((ROOT / SUITE / "coverage.json").read_text())
    names = [entry["path"] for entry in coverage["sources"] + coverage["optional_sources"]]
    names += ["Cargo.toml", "Cargo.lock", str(SUITE / "check-drift.py"), str(SUITE / "verify.sh")]
    for name in dict.fromkeys(names):
        source, destination = ROOT / name, target / name
        if source.is_symlink():
            raise RuntimeError(f"scratch source is a symlink: {name}")
        if source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
    return coverage


def invoke(target: Path, command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=target, env=env, text=True, capture_output=True, timeout=60, check=False)


def require(result: subprocess.CompletedProcess[str], ok: bool, diagnostic: str, label: str) -> None:
    if (result.returncode == 0) != ok or diagnostic not in (result.stdout + result.stderr):
        raise RuntimeError(f"{label}: unexpected result {result.returncode}\n{result.stdout}\n{result.stderr}")
    print(f"{label}: {'accepted' if ok else 'rejected'}", flush=True)


def main() -> None:
    env = os.environ.copy()
    if shutil.which(env.get("OPENSESAME_LEAN_BIN", "lean")) is None:
        raise RuntimeError("activate the pinned Lean toolchain first")
    with tempfile.TemporaryDirectory(prefix="opensesame-selector-drift-") as temporary:
        target = Path(temporary)
        coverage = copy_snapshot(target)
        check = ["python3", "-I", str(SUITE / "check-drift.py")]
        require(invoke(target, check, env), True, "reviewed sources", "reviewed baseline")
        pyc_marker = target / "forged-bytecode-executed"
        for name in ["cargo-lock-projection.py", "cargo-workspace-projection.py", "cargo-workspace-multipackage.py"]:
            source = target / "scripts/security" / name
            cache = Path(importlib.util.cache_from_source(str(source)))
            cache.parent.mkdir(parents=True, exist_ok=True)
            payload = compile('import os\nfrom pathlib import Path\nPath(os.environ["OPENSESAME_PYC_MARKER"]).write_text("executed")\n', str(source), "exec")
            stat = source.stat()
            cache.write_bytes(importlib._bootstrap_external._code_to_timestamp_pyc(payload, int(stat.st_mtime), stat.st_size))
        forged_env = env | {"OPENSESAME_PYC_MARKER": str(pyc_marker)}
        require(invoke(target, check, forged_env), True, "reviewed sources", "forged bytecode ignored")
        if pyc_marker.exists():
            raise RuntimeError("pre-Cargo drift check executed forged helper bytecode")
        root_manifest = target / "Cargo.toml"
        original_root = root_manifest.read_text()
        marker = "[workspace.dependencies]\n"
        if original_root.count(marker) != 1:
            raise RuntimeError("workspace dependency table is not unique")
        root_manifest.write_text(original_root.replace(marker, marker + 'opensesame_unrelated_probe = "1"\n', 1))
        require(invoke(target, check, env), True, "reviewed sources", "unrelated workspace dependency")
        if original_root.count("\nserde = ") != 1:
            raise RuntimeError("workspace serde dependency is not unique")
        root_manifest.write_text(original_root.replace("\nserde = ", '\nserde = { version = "9.9.9" } # ', 1))
        require(invoke(target, check, env), False, "workspace inputs drift", "relevant workspace dependency")
        root_manifest.write_text(original_root)
        fake_bin = target / "fake-bin"
        fake_bin.mkdir()
        fake = fake_bin / "cargo"
        fake.write_text('#!/bin/sh\nprintf invoked > "$OPENSESAME_CARGO_MARKER"\nexit 0\n')
        fake.chmod(0o755)
        cargo_marker = target / "cargo-invoked"
        controlled = env | {"PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                            "OPENSESAME_CARGO_MARKER": str(cargo_marker)}
        coverage_path = target / SUITE / "coverage.json"
        build = "crates/domain/build.rs"
        (target / build).write_text('fn main() { println!("cargo:rustc-cfg=policy"); }\n')
        for entry in coverage["optional_sources"]:
            if entry["path"] == build:
                entry["sha256"] = hashlib.sha256((target / build).read_bytes()).hexdigest()
        coverage_path.write_text(json.dumps(coverage))
        result = invoke(target, ["bash", str(SUITE / "verify.sh")], controlled)
        require(result, False, "local build script requires separately reviewed coverage", "rehashed implicit build script")
        if cargo_marker.exists():
            raise RuntimeError("Cargo executed before refusing the build script")
        (target / build).unlink()
        for entry in coverage["optional_sources"]:
            if entry["path"] == build:
                entry["sha256"] = None
        package = "crates/domain/Cargo.toml"
        manifest = target / package
        original = manifest.read_text()
        if original.count("[package]\n") != 1:
            raise RuntimeError("domain package table is not unique")
        manifest.write_text(original.replace("[package]\n", '[package]\nbuild = "custom.rs"\n', 1))
        for entry in coverage["sources"]:
            if entry["path"] == package:
                entry["sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        coverage_path.write_text(json.dumps(coverage))
        result = invoke(target, ["bash", str(SUITE / "verify.sh")], controlled)
        require(result, False, "unreviewed Cargo build script or custom path", "rehashed custom build path")
        if cargo_marker.exists():
            raise RuntimeError("Cargo executed before refusing the custom build path")
        manifest.write_text(original)
        for entry in coverage["sources"]:
            if entry["path"] == package:
                entry["sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        coverage_path.write_text(json.dumps(coverage))
        require(invoke(target, check, env), True, "reviewed sources", "restored baseline")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"source-trust-selection-drift-controls: {error}", file=sys.stderr)
        sys.exit(1)
