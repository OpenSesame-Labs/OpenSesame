#!/usr/bin/env python3
"""Security properties of the proof workspace's rustc shim."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name("formal-cargo-isolation.py")
SPEC = importlib.util.spec_from_file_location("formal_cargo_isolation", HELPER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
# Execute reviewed source, never an ignored __pycache__ entry.
exec(compile(HELPER.read_bytes(), str(HELPER), "exec", dont_inherit=True), MODULE.__dict__)


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="formal-cargo-wrapper-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.patch = patch.object(MODULE.tempfile, "tempdir", str(self.root))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_canonical_roots_share_only_their_own_wrapper(self):
        alias = self.root / "alias"
        alias.symlink_to(self.workspace, target_is_directory=True)
        other = self.root / "other"
        other.mkdir()
        wrapper = MODULE.wrapper_for(self.workspace)
        self.assertEqual(wrapper, MODULE.wrapper_for(alias))
        self.assertNotEqual(wrapper, MODULE.wrapper_for(other))
        self.assertEqual(wrapper.read_bytes(), MODULE.SHIM)
        self.assertEqual(wrapper.stat().st_mode & 0o777, 0o700)

    def test_forged_or_symlinked_wrapper_is_refused(self):
        wrapper = MODULE.wrapper_for(self.workspace)
        wrapper.write_text("#!/bin/sh\nexit 0\n")
        with self.assertRaisesRegex(ValueError, "differs from the trusted shim"):
            MODULE.wrapper_for(self.workspace)
        wrapper.unlink()
        target = self.root / "target"
        target.write_text("unchanged")
        wrapper.symlink_to(target)
        with self.assertRaises(OSError):
            MODULE.wrapper_for(self.workspace)
        self.assertEqual(target.read_text(), "unchanged")

    def test_nonprivate_parent_and_wrong_mode_are_refused(self):
        parent = self.root / f"opensesame-formal-cargo-{os.geteuid()}"
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "not private"):
            MODULE.wrapper_for(self.workspace)
        parent.chmod(0o700)
        wrapper = MODULE.wrapper_for(self.workspace)
        wrapper.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "differs from the trusted shim"):
            MODULE.wrapper_for(self.workspace)

    def test_interrupted_temporary_file_and_compiler_log(self):
        parent = self.root / f"opensesame-formal-cargo-{os.geteuid()}"
        parent.mkdir(mode=0o700)
        (parent / ".wrapper-interrupted").write_text("partial")
        wrapper = MODULE.wrapper_for(self.workspace)
        log = self.root / "rustc.log"
        env = os.environ.copy() | {"OPENSESAME_FORMAL_RUSTC_LOG": str(log)}
        result = subprocess.run(
            [str(wrapper), "/bin/true", "--crate-name", "checked_crate"],
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(log.read_text(), "checked_crate\n")

    def test_mutation_updates_only_its_covered_hash_and_restores(self):
        source = self.workspace / "source.rs"
        source.write_text("first guard last\n")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        coverage = self.workspace / "coverage.json"
        original = json.dumps({
            "sources": [{"path": "unrelated", "sha256": "unchanged"}],
            "nats": {"sources": [{"path": "source.rs", "sha256": digest}]},
        }).encode()
        coverage.write_bytes(original)
        checker = self.workspace / "check.py"
        checker.write_text(textwrap.dedent('''\
            import hashlib, json
            from pathlib import Path
            root = Path(__file__).parent
            value = json.loads((root / "coverage.json").read_text())
            assert value["sources"][0]["sha256"] == "unchanged"
            actual = hashlib.sha256((root / "source.rs").read_bytes()).hexdigest()
            assert value["nats"]["sources"][0]["sha256"] == actual
            '''))
        with self.assertRaisesRegex(RuntimeError, "witness failed"):
            with MODULE.mutated_coverage(self.workspace, coverage, source, "guard", "mutant",
                                         checker, section="nats"):
                self.assertEqual(source.read_text(), "first mutant last\n")
                subprocess.run([sys.executable, "-I", str(checker)], check=True)
                raise RuntimeError("witness failed")
        self.assertEqual(source.read_text(), "first guard last\n")
        self.assertEqual(coverage.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            with MODULE.mutated_coverage(self.workspace, coverage, source, "absent", "mutant",
                                         checker, section="nats"):
                pass
        self.assertEqual(coverage.read_bytes(), original)

    def test_stable_scratch_checkout_and_foreign_paths(self):
        with MODULE.scratch_checkout(self.workspace) as first:
            path = first.path
            (path / "owned").write_text("scratch")
            self.assertTrue(os.get_inheritable(first.lock_fd))
        self.assertFalse(path.exists())
        with MODULE.scratch_checkout(self.workspace) as second:
            self.assertEqual(second.path, path)
            self.assertEqual(list(second.path.iterdir()), [])
        foreign = self.root / "foreign"
        foreign.mkdir()
        (foreign / "keep").write_text("untouched")
        path.symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "unregistered"):
            with MODULE.scratch_checkout(self.workspace):
                pass
        self.assertEqual((foreign / "keep").read_text(), "untouched")
        path.unlink()

    def test_foreign_directory_cannot_replace_registered_inode(self):
        moved = self.root / "moved-owned"
        with self.assertRaisesRegex(ValueError, "registered inode"):
            with MODULE.scratch_checkout(self.workspace) as lease:
                path = lease.path
                path.rename(moved)
                path.mkdir(mode=0o700)
                (path / "foreign").write_text("preserve")
        self.assertEqual((path / "foreign").read_text(), "preserve")
        self.assertTrue(moved.is_dir())

    def test_old_cleanup_cannot_retire_a_successor_checkout(self):
        with MODULE.scratch_checkout(self.workspace) as first:
            info = first.path.stat()
            old = (info.st_dev, info.st_ino)
            old_directory = os.open(first.path, os.O_RDONLY | os.O_DIRECTORY)
            old_hold = os.dup(first.lock_fd)
        self.assertTrue(first.path.is_dir())
        os.close(old_hold)
        with MODULE.scratch_checkout(self.workspace) as successor:
            current = successor.path.stat()
            self.assertNotEqual((current.st_dev, current.st_ino), old)
            os.close(old_directory)
            (successor.path / "successor").write_text("preserve")
            successor_hold = os.dup(successor.lock_fd)
        os.close(successor_hold)
        MODULE.cleanup_scratch(self.workspace, expected=old)
        self.assertEqual((successor.path / "successor").read_text(), "preserve")
        MODULE.cleanup_scratch(self.workspace)
        self.assertFalse(successor.path.exists())

    def test_unsupported_lock_or_atomic_registration_fails_closed(self):
        with patch.object(MODULE, "fcntl", None):
            with self.assertRaisesRegex(ValueError, "unsupported"):
                with MODULE.scratch_checkout(self.workspace):
                    pass
        source = self.root / "stage"
        source.mkdir()
        target = self.root / "checkout"
        with patch.object(MODULE.sys, "platform", "unsupported-platform"):
            with self.assertRaisesRegex(ValueError, "unsupported"):
                MODULE.rename_noreplace(source, target)
        self.assertTrue(source.is_dir())
        self.assertFalse(target.exists())

    def test_hard_kill_during_registration_recovers_without_deleting_foreign(self):
        code = textwrap.dedent('''\
            import os, signal, sys
            from pathlib import Path
            path = Path(sys.argv[1])
            scope = {"__name__": "scratch_test", "__file__": str(path)}
            exec(compile(path.read_bytes(), str(path), "exec", dont_inherit=True), scope)
            def die(source, target):
                if str(target).endswith(sys.argv[3]):
                    os.kill(os.getpid(), signal.SIGKILL)
                return original(source, target)
            original = scope["rename_noreplace"]
            scope["rename_noreplace"] = die
            with scope["scratch_checkout"](Path(sys.argv[2])):
                pass
            ''')
        env = os.environ.copy() | {"TMPDIR": str(self.root)}
        for suffix in (".json", ".checkout"):
            result = subprocess.run([sys.executable, "-I", "-c", code, str(HELPER),
                                     str(self.workspace), suffix], env=env, check=False)
            self.assertEqual(result.returncode, -signal.SIGKILL)
            # An unregistered empty stage may remain; registered stages are
            # removed by inode after the interrupted creator's lock releases.
            with MODULE.scratch_checkout(self.workspace) as lease:
                self.assertEqual(list(lease.path.iterdir()), [])


class CargoIsolationTests(unittest.TestCase):
    """Compile a failing mutant then live source against the same target."""

    setUp = WrapperTests.setUp

    def make_workspace(self, name, value):
        root = self.root / name
        (root / "src").mkdir(parents=True)
        (root / ".cargo").mkdir()
        (root / "Cargo.toml").write_text(textwrap.dedent('''\
            [package]
            name = "formal-cargo-isolation-probe"
            version = "0.1.0"
            edition = "2021"
            [workspace]
            '''))
        (root / "Cargo.lock").write_text(textwrap.dedent('''\
            version = 4
            [[package]]
            name = "formal-cargo-isolation-probe"
            version = "0.1.0"
            '''))
        source = root / "src/lib.rs"
        source.write_text(
            f'pub fn value() -> u8 {{ {value} }}\n'
            '#[test] fn live_value() { assert_eq!(value(), 1); }\n'
        )
        # Identical old mtimes reproduce the cross-checkout stale-cache risk.
        for path in (root / "Cargo.toml", root / "Cargo.lock", source):
            os.utime(path, (946684800, 946684800))
        fake = self.root / "fake-outer-wrapper"
        fake.write_text(f'#!/bin/sh\nprintf invoked > "{self.root / "fake-marker"}"\nexit 1\n')
        fake.chmod(0o700)
        (root / ".cargo/config.toml").write_text(
            f'[build]\nrustc-wrapper = "{fake}"\nrustc-workspace-wrapper = "{fake}"\n'
        )
        return root

    def cargo(self, root, target, extra=()):
        env = os.environ.copy() | {
            "CARGO_TARGET_DIR": str(target),
            "CARGO_INCREMENTAL": "0",
            "CARGO_NET_OFFLINE": "true",
            "CARGO_BUILD_JOBS": "1",
            "RUSTC_WRAPPER": "",
            "RUSTC_WORKSPACE_WRAPPER": str(MODULE.wrapper_for(root)),
            "OPENSESAME_FORMAL_RUSTC_LOG": str(root / "rustc.log"),
        }
        return subprocess.run(
            ["cargo", "test", "--locked", "--offline", *extra],
            cwd=root,
            env=env,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )

    def test_failed_scratch_build_cannot_contaminate_live_workspace(self):
        scratch = self.make_workspace("scratch", 0)
        live = self.make_workspace("live", 1)
        target = self.root / "shared-target"
        fake = str(self.root / "fake-outer-wrapper")
        with patch.dict(os.environ, {
            "RUSTC_WRAPPER": fake,
            "RUSTC_WORKSPACE_WRAPPER": fake,
            "CARGO_BUILD_RUSTC_WRAPPER": fake,
            "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER": fake,
        }):
            for extra in ((), ("--target", self.host_triple())):
                with self.subTest(extra=extra):
                    log = live / "rustc.log"
                    before = len(log.read_text().splitlines()) if log.exists() else 0
                    bad = self.cargo(scratch, target, extra)
                    self.assertEqual(bad.returncode, 101, bad.stdout + bad.stderr)
                    self.assertIn("live_value ... FAILED", bad.stdout)
                    good = self.cargo(live, target, extra)
                    self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
                    self.assertIn("live_value ... ok", good.stdout)
                    new_entries = log.read_text().splitlines()[before:]
                    self.assertIn("formal_cargo_isolation_probe", new_entries)
        self.assertFalse((self.root / "fake-marker").exists(), "configured rustc-wrapper ran")

    def test_nested_harness_external_path_dependency_has_separate_target(self):
        checkouts = []
        for name, value in (("scratch-outer", 0), ("live-outer", 1)):
            checkout = self.root / name
            dep = checkout / "dep"
            harness = checkout / "harness"
            (dep / "src").mkdir(parents=True)
            (harness / "src").mkdir(parents=True)
            (dep / "Cargo.toml").write_text(textwrap.dedent('''\
                [package]
                name = "external-proof-probe"
                version = "0.1.0"
                edition = "2021"
                [workspace]
                '''))
            (dep / "src/lib.rs").write_text(f'pub fn value() -> u8 {{ {value} }}\n')
            (harness / "Cargo.toml").write_text(textwrap.dedent('''\
                [package]
                name = "nested-proof-probe"
                version = "0.1.0"
                edition = "2021"
                [workspace]
                [dependencies]
                external-proof-probe = { path = "../dep" }
                '''))
            (harness / "Cargo.lock").write_text(textwrap.dedent('''\
                version = 4
                [[package]]
                name = "external-proof-probe"
                version = "0.1.0"
                [[package]]
                name = "nested-proof-probe"
                version = "0.1.0"
                dependencies = ["external-proof-probe"]
                '''))
            (harness / "src/lib.rs").write_text(
                '#[test] fn live_value() { assert_eq!(external_proof_probe::value(), 1); }\n'
            )
            for file in (dep / "Cargo.toml", dep / "src/lib.rs", harness / "Cargo.toml",
                         harness / "Cargo.lock", harness / "src/lib.rs"):
                os.utime(file, (946684800, 946684800))
            checkouts.append((checkout, harness))
        scratch, live = checkouts
        # Like the authority runner, each invocation owns a private scratch
        # target rather than inheriting the shared workspace target.
        bad = self.cargo(scratch[1], scratch[0] / "scratch-target")
        self.assertEqual(bad.returncode, 101, bad.stdout + bad.stderr)
        self.assertIn("live_value ... FAILED", bad.stdout)
        good = self.cargo(live[1], live[0] / "scratch-target")
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        self.assertIn("live_value ... ok", good.stdout)
        self.assertIn("Compiling external-proof-probe", good.stderr)

    @staticmethod
    def host_triple():
        result = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True)
        return next(line.removeprefix("host: ") for line in result.stdout.splitlines()
                    if line.startswith("host: "))


if __name__ == "__main__":
    unittest.main()
