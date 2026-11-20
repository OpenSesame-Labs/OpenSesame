#!/usr/bin/env python3
"""Real Cargo regression for formal-proof artifact freshness."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts/security/formal-cargo-freshness.py"
ISOLATION = ROOT / "scripts/security/formal-cargo-isolation.py"
SPEC = importlib.util.spec_from_file_location("formal_cargo_freshness", VALIDATOR)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("freshness helper unavailable")
freshness = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = freshness
exec(compile(VALIDATOR.read_bytes(), str(VALIDATOR), "exec", dont_inherit=True), freshness.__dict__)


def put(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)


def command(args: list[str], env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, env=env, cwd=cwd, text=True, capture_output=True,
                          timeout=90, check=False)


def fixture(repo: Path, value: int, test_name: str) -> None:
    put(repo / "Cargo.toml", '[workspace]\nmembers = ["app"]\nexclude = ["outside", "inactive"]\nresolver = "2"\n')
    put(repo / "app/Cargo.toml", '''[package]
name = "fixture-app"
version = "0.1.0"
edition = "2021"
[dependencies]
outside = { package = "fixture-outside", path = "../outside" }
inactive = { package = "fixture-inactive", path = "../inactive", optional = true }
''')
    for name in ("outside", "inactive"):
        put(repo / name / "Cargo.toml", f'''[package]
name = "fixture-{name}"
version = "0.1.0"
edition = "2021"
[workspace]
''')
    put(repo / "outside/src/lib.rs", f"pub fn value() -> u32 {{ {value} }}\n")
    put(repo / "inactive/src/lib.rs", "pub fn inactive() {}\n")
    put(repo / "app/src/lib.rs", f'''pub fn value() -> u32 {{ outside::value() }}
#[cfg(test)]
mod tests {{
    #[test]
    fn {test_name}() {{ assert_eq!(super::value(), {value}); }}
}}
''')
    put(repo / "app/src/main.rs", 'fn main() { println!("{}", fixture_app::value()); }\n')
    put(repo / "app/tests/integration.rs", f'''#[test]
fn integration_target() {{ assert_eq!(fixture_app::value(), {value}); }}
#[test]
fn controlled_failure() {{ panic!("named-witness"); }}
fn change_reviewed_input() {{
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    std::fs::write(root.join("../outside/src/lib.rs"), "pub fn value() -> u32 {{ 99 }}\\n").unwrap();
}}
#[test]
fn drift_after_success() {{ change_reviewed_input(); }}
#[test]
fn drift_after_failure() {{ change_reviewed_input(); panic!("named-drift-witness"); }}
#[test]
fn drift_before_interruption() {{
    change_reviewed_input();
    std::fs::write(std::env::var("DRIFT_MARKER").unwrap(), "ready").unwrap();
    loop {{ std::thread::sleep(std::time::Duration::from_millis(20)); }}
}}
''')
    put(repo / "check.py", f'''from pathlib import Path
root = Path(__file__).resolve().parent
assert (root / "outside/src/lib.rs").read_text() == "pub fn value() -> u32 {{ {value} }}\\n"
''')


class FreshnessTests(unittest.TestCase):
    def test_reviewed_cargo_targets_refuse_redirects_and_build_scripts(self) -> None:
        scope = {"__name__": "target_probe", "__file__": str(ISOLATION)}
        exec(compile(ISOLATION.read_bytes(), str(ISOLATION), "exec", dont_inherit=True), scope)
        with tempfile.TemporaryDirectory(prefix="formal-targets-") as directory:
            root = Path(directory)
            for path in ("src/lib.rs", "src/main.rs", "tests/probe.rs"):
                put(root / path, "// reviewed\n")
            manifest = root / "Cargo.toml"
            base = '[package]\nname="sample"\n[lib]\nname="sample"\npath="src/lib.rs"\n[[bin]]\nname="cli"\npath="src/main.rs"\n'
            inventory = {"Cargo.toml": {"package": "sample", "lib": ("sample", "src/lib.rs"),
                                        "bin": {"cli": "src/main.rs"}, "test": {"probe": "tests/probe.rs"}}}
            covered = {"Cargo.toml", "src/lib.rs", "src/main.rs", "tests/probe.rs"}
            check = lambda: scope["check_cargo_targets"](root, inventory, covered)
            put(manifest, base)
            check()  # The test is implicitly discovered.
            for changed in (
                base.replace('path="src/lib.rs"', 'path="src/other.rs"'),
                base.replace('name="sample"\npath=', 'name="other"\npath='),
                base.replace('path="src/main.rs"', 'path="src/other.rs"'),
                base.replace('[package]\n', '[package]\nautotests=false\n'),
                base.replace('[package]\n', '[package]\nbuild="other.rs"\n'),
                base + '[[test]]\nname="probe"\npath="tests/other.rs"\n',
                base + '[[test]]\nname="probe"\npath="tests/probe.rs"\nharness=false\n',
                base + '[[test]]\npath="tests/probe.rs"\n',
            ):
                put(manifest, changed)
                with self.assertRaises(ValueError):
                    check()
            put(manifest, base + '[[test]]\nname="other"\npath="tests/unrelated.rs"\n')
            check()  # A valid, inactive target does not change the inventory.
            put(manifest, base + '[[test]]\nname="probe"\n')
            check()  # Cargo also infers this explicit declaration's path.
            put(root / "tests/probe/main.rs", "// ambiguous\n")
            with self.assertRaisesRegex(ValueError, "ambiguous implicit"):
                check()
            shutil.rmtree(root / "tests/probe")
            put(root / "build.rs", "fn main() {}\n")
            with self.assertRaisesRegex(ValueError, "build script"):
                check()
            (root / "build.rs").unlink()
            covered.remove("tests/probe.rs")
            with self.assertRaisesRegex(ValueError, "not covered"):
                check()

    def test_session_state_must_be_private_and_not_a_link(self) -> None:
        with tempfile.TemporaryDirectory(prefix="formal-freshness-state-") as directory:
            root = Path(directory)
            state = root / "state.json"
            freshness.save_state(state, {"seen": ["artifact"]}, create=True)
            self.assertEqual(freshness.read_state(state), {"seen": ["artifact"]})
            freshness.save_state(state, {"seen": []})
            self.assertEqual(freshness.read_state(state), {"seen": []})
            with self.assertRaises(FileExistsError):
                freshness.save_state(state, {}, create=True)
            link = root / "link.json"
            link.symlink_to(state)
            with self.assertRaises((OSError, freshness.FreshnessError)):
                freshness.read_state(link)
            state.chmod(0o644)
            with self.assertRaises(freshness.FreshnessError):
                freshness.read_state(state)

    def test_unsupported_shapes_and_unreviewed_manifests_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="formal-freshness-args-") as directory:
            root = Path(directory)
            put(root / "Cargo.toml", "[workspace]\nmembers = []\n")
            put(root / "other/Cargo.toml", "[workspace]\nmembers = []\n")
            state = {"root": str(root), "manifest": str(root / "Cargo.toml"), "roots": ["app"]}
            for args in (
                ["check", "--locked"],
                ["test", "--locked", "--target-dir", "other"],
                ["test", "--locked", "-p", "unreviewed"],
                ["run", "--locked", "--manifest-path", "other/Cargo.toml"],
                ["test", "-p", "app"],
            ):
                with self.subTest(args=args), self.assertRaises(freshness.FreshnessError):
                    freshness.cargo_arguments(args, state)

    def test_killed_validator_keeps_scratch_locked_until_child_writer_exits(self) -> None:
        with tempfile.TemporaryDirectory(prefix="formal-freshness-lock-") as directory:
            outer = Path(directory)
            workspace = outer / "workspace"
            workspace.mkdir()
            started, release, finished = (outer / name for name in ("started", "release", "finished"))
            attempted, acquired = outer / "attempted", outer / "acquired"
            build_source = outer / "build.rs"
            put(build_source, '''use std::{env, fs, path::Path, thread, time::Duration};
fn main() {
    let fd = env::var("OPENSESAME_FORMAL_SCRATCH_LOCK_FD").unwrap();
    assert!(Path::new(&format!("/dev/fd/{fd}")).exists(), "lock descriptor missing");
    let started = env::var("PROBE_STARTED").unwrap();
    let release = env::var("PROBE_RELEASE").unwrap();
    let finished = env::var("PROBE_FINISHED").unwrap();
    fs::write(started, "started").unwrap();
    while !Path::new(&release).exists() { thread::sleep(Duration::from_millis(10)); }
    fs::write("child-write", "finished").unwrap();
    fs::write(finished, "finished").unwrap();
}
''')
            worker = outer / "worker.py"
            put(worker, '''import json, os, pathlib, signal, subprocess, sys, time
helper, validator, workspace, build_source, started, release, finished, target = sys.argv[1:]
source = pathlib.Path(helper)
scope = {"__name__": "scratch_test", "__file__": str(source)}
exec(compile(source.read_bytes(), str(source), "exec", dont_inherit=True), scope)
with scope["scratch_checkout"](pathlib.Path(workspace)) as lease:
    (lease.path / "src").mkdir()
    (lease.path / "Cargo.toml").write_text("[package]\\nname='lock-writer-probe'\\nversion='0.1.0'\\nedition='2021'\\n[workspace]\\n")
    (lease.path / "Cargo.lock").write_text("version=4\\n[[package]]\\nname='lock-writer-probe'\\nversion='0.1.0'\\n")
    (lease.path / "src/lib.rs").write_text("pub fn ok() {}\\n")
    (lease.path / "build.rs").write_text(pathlib.Path(build_source).read_text())
    env = os.environ.copy() | {"OPENSESAME_FORMAL_SCRATCH_LOCK_FD": str(lease.lock_fd),
        "RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": str(scope["wrapper_for"](lease.path)),
        "OPENSESAME_FORMAL_RUSTC_LOG": str(pathlib.Path(target).parent / "rustc.log"),
        "CARGO_TARGET_DIR": target, "CARGO_NET_OFFLINE": "true", "CARGO_INCREMENTAL": "0",
        "CARGO_BUILD_JOBS": "1", "PROBE_STARTED": started, "PROBE_RELEASE": release,
        "PROBE_FINISHED": finished}
    meta = subprocess.run(["cargo", "metadata", "--locked", "--offline", "--no-deps", "--format-version=1"],
                          cwd=lease.path, env=env, text=True, capture_output=True, check=True,
                          pass_fds=(lease.lock_fd,))
    package = json.loads(meta.stdout)["packages"][0]["id"]
    code = """import os, pathlib, sys
p = pathlib.Path(sys.argv[1])
s = {\"__name__\": \"validator_test\", \"__file__\": str(p)}
exec(compile(p.read_bytes(), str(p), \"exec\", dont_inherit=True), s)
s[\"cargo_run\"]([\"cargo\", \"test\", \"--locked\", \"--offline\", \"--no-run\", \"--message-format=json\"], pathlib.Path(sys.argv[2]), os.environ.copy(), {\"packages\": {sys.argv[3]: {\"workspace\": True}}, \"seen\": []}, True)
"""
    child = subprocess.Popen([sys.executable, "-I", "-c", code, validator,
                              str(lease.path), package], env=env,
                             pass_fds=(lease.lock_fd,))
    deadline = time.monotonic() + 30
    while not pathlib.Path(started).exists() and child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    if not pathlib.Path(started).exists(): raise RuntimeError("child did not start")
    child.kill()
    child.wait()
    os.kill(os.getpid(), signal.SIGKILL)
''')
            contender = outer / "contender.py"
            put(contender, '''import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = {"__name__": "scratch_test", "__file__": str(p)}
exec(compile(p.read_bytes(), str(p), "exec", dont_inherit=True), s)
pathlib.Path(sys.argv[3]).write_text("attempted")
with s["scratch_checkout"](pathlib.Path(sys.argv[2])):
    assert pathlib.Path(sys.argv[4]).exists(), "orphan writer still active"
    pathlib.Path(sys.argv[5]).write_text("acquired")
''')
            env = os.environ.copy() | {"TMPDIR": str(outer)}
            first = subprocess.Popen([sys.executable, "-I", str(worker), str(ISOLATION),
                                      str(VALIDATOR), str(workspace), str(build_source), str(started),
                                      str(release), str(finished), str(outer / "target")], env=env)
            second = None
            try:
                self.assertEqual(first.wait(timeout=40), -signal.SIGKILL)
                self.assertTrue(started.exists())
                second = subprocess.Popen([sys.executable, "-I", str(contender), str(ISOLATION),
                                           str(workspace), str(attempted), str(finished),
                                           str(acquired)], env=env)
                deadline = time.monotonic() + 10
                while not attempted.exists() and second.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(attempted.exists())
                time.sleep(0.1)
                self.assertIsNone(second.poll(), "successor acquired while child was writing")
                self.assertFalse(acquired.exists())
                release.write_text("release")
                self.assertEqual(second.wait(timeout=30), 0)
                self.assertTrue(finished.exists())
                self.assertTrue(acquired.exists())
            finally:
                release.write_text("release")
                if first.poll() is None:
                    first.kill()
                    first.wait()
                if second is not None and second.poll() is None:
                    second.kill()
                    second.wait()

    def test_interrupted_scratch_and_same_path_replacement_rebuild_local_targets(self) -> None:
        if not ISOLATION.is_file():
            self.fail("reviewed formal-cargo-isolation.py is required")
        with tempfile.TemporaryDirectory(prefix="formal-freshness-cargo-") as directory:
            outer = Path(directory)
            live, scratch, target = outer / "live", outer / "scratch", outer / "target"
            fixture(live, 17, "expected_live_result")
            env = os.environ.copy() | {
                "CARGO_HOME": str(outer / "cargo-home"),
                "CARGO_TARGET_DIR": str(target),
                "CARGO_NET_OFFLINE": "true",
                "CARGO_INCREMENTAL": "0",
                "CARGO_BUILD_JOBS": "1",
                "RUST_TEST_THREADS": "1",
            }
            env.pop("RUSTC_WRAPPER", None)
            env.pop("RUSTC_WORKSPACE_WRAPPER", None)
            for manifest in (live / "Cargo.toml", live / "outside/Cargo.toml", live / "inactive/Cargo.toml"):
                lock = command(["cargo", "generate-lockfile", "--offline", "--manifest-path", str(manifest)], env, live)
                self.assertEqual(lock.returncode, 0, lock.stderr)
            shutil.copytree(live, scratch, copy_function=shutil.copy2)
            put(scratch / "outside/src/lib.rs", "pub fn value() -> u32 { 99 }\n")
            stamp = (live / "outside/src/lib.rs").stat().st_mtime_ns
            os.utime(scratch / "outside/src/lib.rs", ns=(stamp, stamp))
            wrapper = command([sys.executable, "-I", str(ISOLATION), str(scratch)], env, scratch)
            self.assertEqual(wrapper.returncode, 0, wrapper.stderr)
            scratch_env = env | {"RUSTC_WORKSPACE_WRAPPER": wrapper.stdout.strip(), "RUSTC_WRAPPER": ""}
            # Compile the mutant, then kill its owner before cleanup. The
            # target directory deliberately retains the compiled artifacts.
            marker = outer / "scratch-built"
            worker_code = '''import pathlib, signal, subprocess, sys
subprocess.run(["cargo", "test", "--offline", "--locked", "-p", "fixture-app", "--lib", "--no-run"], check=True)
pathlib.Path(sys.argv[1]).write_text("built")
signal.pause()
'''
            worker = subprocess.Popen([sys.executable, "-c", worker_code, str(marker)],
                                      cwd=scratch, env=scratch_env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 60
            while not marker.exists() and worker.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if not marker.exists():
                worker.kill()
                out, err = worker.communicate()
                self.fail(f"scratch build failed or timed out: {out}\n{err}")
            worker.send_signal(signal.SIGKILL)
            worker.communicate(timeout=10)

            # A configured wrapper that refuses all compilation must be
            # overridden by the child-only empty RUSTC_WRAPPER value.
            fake = live / "fake-wrapper.sh"
            put(fake, '#!/bin/sh\necho invoked > "$(dirname "$0")/forged-marker"\nexit 7\n')
            fake.chmod(0o700)
            put(live / ".cargo/config.toml", f'[build]\nrustc-wrapper = "{fake}"\n')
            live_env = self.session(live, env, outer / "live-state")
            result = self.proof(live, live_env, outer / "live-state", ["test", "--locked", "-p", "fixture-app", "--lib"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("test tests::expected_live_result ... ok", result.stdout)
            self.assertFalse((live / "forged-marker").exists())

            # Replace the directory at the exact same canonical path with old
            # mtimes. A new session must rebuild both the member and its
            # nonmember local dependency before allowing the new test to run.
            replacement = outer / "replacement"
            shutil.copytree(live, replacement, copy_function=shutil.copy2)
            fixture(replacement, 23, "replacement_v2")
            for path in replacement.rglob("*.rs"):
                os.utime(path, ns=(stamp, stamp))
            live.rename(outer / "retired")
            replacement.rename(live)
            live_env = self.session(live, env, outer / "replacement-state")
            result = self.proof(live, live_env, outer / "replacement-state", ["test", "--locked", "-p", "fixture-app", "--lib"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("test tests::replacement_v2 ... ok", result.stdout)
            result = self.proof(live, live_env, outer / "replacement-state", ["test", "--locked", "-p", "fixture-app", "--test", "integration", "integration_target", "--", "--exact"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("test integration_target ... ok", result.stdout)
            result = self.proof(live, live_env, outer / "replacement-state", ["test", "--locked", "-p", "fixture-app", "--test", "integration", "controlled_failure", "--", "--exact"])
            self.assertEqual(result.returncode, 101, result.stderr)
            self.assertIn("test controlled_failure ... FAILED", result.stdout)
            self.assertIn("named-witness", result.stdout)
            result = self.proof(live, live_env, outer / "replacement-state", ["run", "--locked", "-p", "fixture-app", "--bin", "fixture-app"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("23", result.stdout.splitlines())
            reviewed = live / "outside/src/lib.rs"
            for name in ("drift_after_success", "drift_after_failure"):
                result = self.proof(live, live_env, outer / "replacement-state", ["test", "--locked", "-p", "fixture-app", "--test", "integration", name, "--", "--exact"])
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("AssertionError", result.stderr)
                reviewed.write_text("pub fn value() -> u32 { 23 }\n")
            marker = outer / "drift-interrupted"
            args = [sys.executable, "-I", str(VALIDATOR), "run", "--state", str(outer / "replacement-state"),
                    "--input-check", str(live / "check.py"), "--", "test", "--locked", "-p", "fixture-app",
                    "--test", "integration", "drift_before_interruption", "--", "--exact"]
            interrupted = subprocess.Popen(args, cwd=live, env=live_env | {"DRIFT_MARKER": str(marker)},
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 60
                while not marker.exists() and interrupted.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists(), "interruption test did not reach the mutation")
                interrupted.send_signal(signal.SIGTERM)
                _, stderr = interrupted.communicate(timeout=15)
                self.assertEqual(interrupted.returncode, 1, stderr)
                self.assertIn("AssertionError", stderr)
            finally:
                if interrupted.poll() is None:
                    interrupted.kill()
                    interrupted.communicate(timeout=10)

    def session(self, repo: Path, env: dict[str, str], state: Path) -> dict[str, str]:
        wrapper = command([sys.executable, "-I", str(ISOLATION), str(repo)], env, repo)
        self.assertEqual(wrapper.returncode, 0, wrapper.stderr)
        selected = env | {"RUSTC_WORKSPACE_WRAPPER": wrapper.stdout.strip()}
        result = command([sys.executable, "-I", str(VALIDATOR), "init", "--repo", str(repo),
                          "--manifest", str(repo / "Cargo.toml"), "--state", str(state),
                          "--package", "fixture-app"], selected, repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        return selected

    def proof(self, repo: Path, env: dict[str, str], state: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
        return command([sys.executable, "-I", str(VALIDATOR), "run", "--state", str(state),
                        "--input-check", str(repo / "check.py"), "--", *args], env, repo)


if __name__ == "__main__":
    unittest.main()
