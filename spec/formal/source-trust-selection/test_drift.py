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


def fixture_controls(scratch: Path, env: dict, runner: list, rows: list, run) -> None:
    """Check the complete runner rejects missing/corrupt fixtures before Cargo."""
    fake_bin = scratch / "fake-bin"
    fake_bin.mkdir()
    fake = fake_bin / "cargo"
    fake.write_text('#!/bin/sh\nprintf invoked > "$OPENSESAME_NATS_CARGO_MARKER"\nexit 99\n')
    fake.chmod(0o755)
    cargo_marker = scratch / "unexpected-cargo"
    no_cargo_env = env | {"PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                          "OPENSESAME_NATS_CARGO_MARKER": str(cargo_marker)}
    missing_env = no_cargo_env | {"OPENSESAME_MTLS_FIXTURE_DIR": str(scratch / "missing-fixture")}
    missing = run(runner, scratch, missing_env)
    if (missing.returncode == 0 or "install the pinned fixture separately" not in missing.stderr or
            (scratch / "missing-fixture").exists() or cargo_marker.exists()):
        raise RuntimeError(f"missing fixture not rejected\n{missing.stdout}\n{missing.stderr}")
    print("missing NATS fixture without implicit fetch: rejected", flush=True)
    bad_dir = scratch / "bad-fixture" / f"nats-server-{rows[0][1]}"
    bad_dir.mkdir(parents=True)
    bad_binary = bad_dir / Path(rows[0][2]).name
    bad_archive = bad_dir / rows[0][5].rsplit("/", 1)[-1]
    bad_binary.write_bytes(b"not a verified binary")
    bad_binary.chmod(0o700)
    bad_archive.write_bytes(b"not a verified archive")
    bad_env = no_cargo_env | {"OPENSESAME_MTLS_FIXTURE_DIR": str(bad_dir.parent)}
    bad = run(runner, scratch, bad_env)
    if (bad.returncode == 0 or "install the pinned fixture separately" not in bad.stderr or
            bad_binary.read_bytes() != b"not a verified binary" or
            bad_archive.read_bytes() != b"not a verified archive" or cargo_marker.exists()):
        raise RuntimeError(f"corrupt fixture not rejected\n{bad.stdout}\n{bad.stderr}")
    print("corrupt NATS fixture without implicit fetch: rejected", flush=True)


def retry_vector_controls(scratch: Path, env: dict, helper: dict, checker: Path,
                          rows: list, vectors: Path, test: str, require_failure) -> None:
    command = ["test", "--locked", "-p", "opensesame-task-bus", "--features", "live-tests", "--lib", test, "--", "--ignored", "--exact"]
    cases = [
        ("empty retry vectors", [], "incomplete retry vector matrix"),
        ("missing retry vector", rows[:-1], "incomplete retry vector matrix"),
        ("duplicate retry vector", [rows[0], *rows], "duplicate retry vector"),
        ("malformed retry output", [rows[0].rsplit("\t", 1)[0] + "\tbogus", *rows[1:]], "invalid retry vector value"),
    ]
    for label, case, diagnostic in cases:
        vectors.write_text("\n".join(case) + ("\n" if case else ""))
        result = helper["checked_cargo"](scratch, env, ["opensesame-task-bus"], checker, command)
        require_failure(result, test, diagnostic, label)
    vectors.write_text("\n".join(rows) + "\n")


def copy_snapshot(target: Path, nats: bool = False) -> dict:
    coverage = json.loads((ROOT / SUITE / "coverage.json").read_text())
    selected = coverage["nats"] if nats else coverage
    names = [entry["path"] for entry in selected["sources"] + selected["optional_sources"]]
    names += ["Cargo.toml", "Cargo.lock", str(SUITE / "check-drift.py"), str(SUITE / "verify.sh")]
    # The checker re-runs the vendored SQLx verifier: its tree, archive and both workspaces' bindings.
    vendored = ROOT / "patches/vendor/sqlx-sqlite-0.9.0"
    names += [str(path.relative_to(ROOT)) for path in sorted(vendored.rglob("*")) if not path.is_dir()]
    names += ["patches/vendor/sqlx-sqlite-0.9.0.crate", "tests/fuzz/cargo/Cargo.toml", "tests/fuzz/cargo/Cargo.lock"]
    for name in dict.fromkeys(names):
        source, destination = ROOT / name, target / name
        if source.is_symlink():
            raise RuntimeError(f"scratch source is a symlink: {name}")
        if source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
    return coverage


def nats_controls() -> None:
    env = os.environ.copy() | {"OPENSESAME_FORMAL_NATS": "1"}
    with tempfile.TemporaryDirectory(prefix="opensesame-nats-drift-") as temporary:
        target = Path(temporary)
        coverage = copy_snapshot(target, nats=True)
        nats = coverage["nats"]
        check = ["python3", "-I", str(SUITE / "check-drift.py"), "--nats"]
        require(invoke(target, check, env), True, "reviewed sources", "NATS reviewed baseline")
        vendored = target / "patches/vendor/sqlx-sqlite-0.9.0/src/row.rs"
        original_vendored = vendored.read_bytes()
        vendored.write_bytes(original_vendored + b"\n// unreviewed vendored edit\n")
        require(invoke(target, check, env), False, "SQLx source differs beyond the manifest fix", "NATS unreviewed vendored SQLx edit")
        vendored.write_bytes(original_vendored)
        runner = target / SUITE / "verify.sh"
        original_runner = runner.read_text()
        required_test = "nats::live_tests::injected_spiffe_client_matches_locator_and_profile"
        if original_runner.count(required_test) != 1:
            raise RuntimeError("NATS client correspondence target is not unique")
        runner.write_text(original_runner.replace(required_test, "nats::live_tests::renamed_client_test", 1))
        require(invoke(target, check, env), False, "NATS exact test inventory drift", "renamed NATS test target")
        runner.write_text(original_runner)
        for name in ["crates/task-bus/src/nats_connect.rs", "ops/nats/local-dev.conf", "scripts/mtls/mtls-fixtures.sh",
                     "rust-toolchain.toml", *[
                         "crates/domain/Cargo.toml", "crates/task-bus/Cargo.toml",
                         "crates/transport-security/Cargo.toml", "crates/xkeys/Cargo.toml"]]:
            path = target / name
            original = path.read_bytes()
            path.write_bytes(original + b"\n# drift control\n")
            require(invoke(target, check, env), False, "review source drift", f"NATS {name} drift")
            path.write_bytes(original)
        lockfile = target / "Cargo.lock"
        original_lock = lockfile.read_text()
        lockfile.write_text(original_lock + '\n[[package]]\nname = "nats-unrelated-control"\nversion = "1.0.0"\n')
        require(invoke(target, check, env), True, "reviewed sources", "unrelated lock package")
        import re
        match = re.search(r'(?ms)^\[\[package\]\]\nname = "async-nats"\n(?:(?!^\[\[package\]\]).)*?^checksum = "([0-9a-f]{64})"', original_lock)
        if match is None:
            raise RuntimeError("async-nats checksum is unavailable")
        before = match.group(1)
        after = ("0" if before[0] != "0" else "1") + before[1:]
        lockfile.write_text(original_lock[:match.start(1)] + after + original_lock[match.end(1):])
        require(invoke(target, check, env), False, "dependency graph drift", "NATS dependency checksum")
        lockfile.write_text(original_lock)
        workspace = target / "Cargo.toml"
        original_workspace = workspace.read_text()
        workspace.write_text(original_workspace.replace('[workspace.dependencies]\n',
                                                       '[workspace.dependencies]\nunrelated_nats_probe = "1"\n', 1))
        require(invoke(target, check, env), True, "reviewed sources", "unrelated workspace dependency")
        workspace.write_text(original_workspace.replace('\nserde = ', '\nserde = { version = "9.9.9" } # ', 1))
        require(invoke(target, check, env), False, "workspace inputs drift", "NATS inherited dependency")
        workspace.write_text(original_workspace)
        for name in ["crates/domain/build.rs", "crates/task-bus/build.rs",
                     "crates/transport-security/build.rs", "crates/xkeys/build.rs"]:
            path = target / name
            path.write_text("fn main() {}\n")
            require(invoke(target, check, env), False, "optional source/build configuration drift", f"NATS {name}")
            path.unlink()
        for name in ["crates/domain/Cargo.toml", "crates/task-bus/Cargo.toml",
                     "crates/transport-security/Cargo.toml", "crates/xkeys/Cargo.toml"]:
            manifest = target / name
            original = manifest.read_text()
            if "[lib]\n" in original:
                if original.count('path = "src/lib.rs"') != 1:
                    raise RuntimeError(f"unexpected library target in {name}")
                changed = original.replace('path = "src/lib.rs"', 'path = "src/unreviewed.rs"', 1)
            else:
                changed = original + '\n[lib]\npath = "src/unreviewed.rs"\n'
            alternate = manifest.parent / "src/unreviewed.rs"
            alternate.write_text("pub fn unreviewed_target() {}\n")
            manifest.write_text(changed)
            entry = next(item for item in nats["sources"] if item["path"] == name)
            entry["sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
            (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
            require(invoke(target, check, env), False, "reviewed Cargo lib target changed", f"NATS rehashed library redirect: {name}")
            manifest.write_text(original)
            entry["sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
            (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
            alternate.unlink()
        task_manifest = target / "crates/task-bus/Cargo.toml"
        original = task_manifest.read_text()
        entry = next(item for item in nats["sources"] if item["path"] == "crates/task-bus/Cargo.toml")
        for attribute in ['name = "other"', 'test = false', 'harness = false', 'required-features = ["other"]']:
            task_manifest.write_text(original + f"\n[lib]\n{attribute}\n")
            entry["sha256"] = hashlib.sha256(task_manifest.read_bytes()).hexdigest()
            (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
            require(invoke(target, check, env), False, "reviewed Cargo lib target changed", f"NATS rehashed target attribute: {attribute}")
        task_manifest.write_text(original)
        entry["sha256"] = hashlib.sha256(task_manifest.read_bytes()).hexdigest()
        (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
        manifest = target / "crates/task-bus/Cargo.toml"
        original_manifest = manifest.read_text()
        manifest.write_text(original_manifest.replace("[package]\n", '[package]\nbuild = "custom.rs"\n', 1))
        for entry in nats["sources"]:
            if entry["path"] == "crates/task-bus/Cargo.toml":
                entry["sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        (target / SUITE / "coverage.json").write_text(json.dumps(coverage))
        require(invoke(target, check, env), False, "unreviewed Cargo build script or custom path", "NATS rehashed custom build path")
        manifest.write_text(original_manifest)
        selector_env = env | {"OPENSESAME_FORMAL_NATS": "0"}
        require(invoke(target, ["python3", "-I", str(SUITE / "check-drift.py")], selector_env), False,
                "missing covered path", "NATS snapshot excludes gateway sources")


def invoke(target: Path, command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=target, env=env, text=True, capture_output=True, timeout=60, check=False)


def require(result: subprocess.CompletedProcess[str], ok: bool, diagnostic: str, label: str) -> None:
    if (result.returncode == 0) != ok or diagnostic not in (result.stdout + result.stderr):
        raise RuntimeError(f"{label}: unexpected result {result.returncode}\n{result.stdout}\n{result.stderr}")
    print(f"{label}: {'accepted' if ok else 'rejected'}", flush=True)


def main() -> None:
    env = os.environ.copy() | {"OPENSESAME_FORMAL_NATS": "0"}
    if shutil.which(env.get("OPENSESAME_LEAN_BIN", "lean")) is None:
        raise RuntimeError("activate the pinned Lean toolchain first")
    with tempfile.TemporaryDirectory(prefix="opensesame-selector-drift-") as temporary:
        target = Path(temporary)
        coverage = copy_snapshot(target)
        check = ["python3", "-I", str(SUITE / "check-drift.py")]
        require(invoke(target, check, env), True, "reviewed sources", "reviewed baseline")
        vendored = target / "patches/vendor/sqlx-sqlite-0.9.0/src/row.rs"
        original_vendored = vendored.read_bytes()
        vendored.write_bytes(original_vendored + b"\n// unreviewed vendored edit\n")
        require(invoke(target, check, env), False, "SQLx source differs beyond the manifest fix", "unreviewed vendored SQLx edit")
        vendored.write_bytes(original_vendored)
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
        if sys.argv[1:] == ["--nats"]:
            nats_controls()
        elif not sys.argv[1:]:
            main()
        else:
            raise RuntimeError("expected no arguments or --nats")
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"source-trust-selection-drift-controls: {error}", file=sys.stderr)
        sys.exit(1)
