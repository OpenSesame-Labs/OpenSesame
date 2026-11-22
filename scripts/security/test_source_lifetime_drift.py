#!/usr/bin/env python3
"""Exercise source-lifetime drift checks without modifying a live worktree."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "security"))
from formal_coverage_drift import assert_reviewed_revision_on_main
SCRIPT = ROOT / "spec/formal/source-lifetime/check-drift.py"


def load_checker():
    spec = importlib.util.spec_from_file_location("source_lifetime_drift", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DriftTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lifetime-drift-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.checker = load_checker()
        self.checker.ROOT = self.root
        for name in [*self.checker.PATHS, "Cargo.lock", "scripts/security/cargo-lock-projection.py",
                     "spec/formal/source-lifetime/coverage.json"]:
            source, target = ROOT / name, self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        def repo_git(*args: str):
            return subprocess.run(
                ["git", "-C", str(ROOT), *args],
                capture_output=True,
                env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
                check=False,
            )

        self.checker.git = repo_git
        self.checker.assert_reviewed_revision_on_main = (
            lambda root, revision, label: assert_reviewed_revision_on_main(
                ROOT, revision, label
            )
        )

    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.checker.main()

    def test_reviewed_inputs_pass(self):
        self.check()

    def test_added_implicit_build_script_is_rejected(self):
        (self.root / "crates/domain/build.rs").write_text("fn main() {}\n")
        with self.assertRaisesRegex(SystemExit, "optional source/build-script drift"):
            self.check()

    def test_symlinked_build_script_is_rejected(self):
        (self.root / "crates/gateway/build.rs").symlink_to(self.root / "Cargo.lock")
        with self.assertRaisesRegex(SystemExit, "not a regular file"):
            self.check()

    def test_modified_covered_source_is_rejected(self):
        path = self.root / "crates/transport-security/src/guard.rs"
        path.write_text(path.read_text() + "\n// drift\n")
        with self.assertRaisesRegex(SystemExit, "review source drift"):
            self.check()

    def test_replaced_hash_without_reviewed_blob_is_rejected(self):
        path = self.root / "crates/transport-security/src/guard.rs"
        path.write_text(path.read_text() + "\n// drift\n")
        manifest = self.root / "spec/formal/source-lifetime/coverage.json"
        data = json.loads(manifest.read_text())
        entry = next(item for item in data["sources"] if item["path"].endswith("guard.rs"))
        entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(
            SystemExit, "reviewed blob does not match hashed bytes"
        ):
            self.check()

    def test_unknown_reviewed_blob_is_rejected(self):
        manifest = self.root / "spec/formal/source-lifetime/coverage.json"
        data = json.loads(manifest.read_text())
        entry = next(item for item in data["sources"] if item["path"].endswith("guard.rs"))
        entry["reviewed_blob"] = "0" * 40
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(SystemExit, "is not in this repository"):
            self.check()

    def test_modified_tls_version_helper_is_rejected(self):
        path = self.root / "crates/transport-security/src/client.rs"
        path.write_text(path.read_text() + "\n// version helper drift\n")
        with self.assertRaisesRegex(SystemExit, "review source drift"):
            self.check()

    def test_same_bytes_symlinked_source_is_rejected(self):
        path = self.root / "crates/transport-security/src/guard.rs"
        twin = self.root / "same-guard.rs"
        twin.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(twin)
        with self.assertRaisesRegex(SystemExit, "not a regular file or directory"):
            self.check()

    def test_symlinked_parent_directory_is_rejected(self):
        path = self.root / "crates/transport-security/src"
        actual = path.with_name("source-copy")
        path.rename(actual)
        path.symlink_to(actual, target_is_directory=True)
        with self.assertRaisesRegex(SystemExit, "not a regular file or directory"):
            self.check()

    def test_missing_required_source_is_rejected(self):
        (self.root / "crates/gateway/src/transport/boot.rs").unlink()
        with self.assertRaises(SystemExit):
            self.check()


class SpiffePrecheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="spiffe-drift-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        script = ROOT / "spec/formal/spiffe/check-drift.py"
        spec = importlib.util.spec_from_file_location("spiffe_drift_precheck", script)
        self.checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.checker)
        self.checker.ROOT = self.root
        data = json.loads((ROOT / "spec/formal/spiffe/coverage.json").read_text())
        paths = {
            *(item["path"] for item in data["sources"]),
            "Cargo.lock",
            "spec/formal/spiffe/coverage.json",
            data["reviewed_attestation"],
        }
        for name in paths:
            source, target = ROOT / name, self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        def repo_git(*args: str):
            return subprocess.run(
                ["git", "-C", str(ROOT), *args],
                capture_output=True,
                env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
                check=False,
            )

        self.checker.git = repo_git
        self.checker.assert_reviewed_revision_on_main = (
            lambda root, revision, label: assert_reviewed_revision_on_main(
                ROOT, revision, label
            )
        )

    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.checker.main()

    def test_reviewed_inputs_pass(self):
        self.check()

    def test_added_build_script_is_rejected(self):
        (self.root / "crates/spiffe-source/build.rs").write_text("fn main() {}\n")
        with self.assertRaisesRegex(SystemExit, "optional source/build-script drift"):
            self.check()

    def test_same_bytes_symlinked_source_is_bound_to_reviewed_blob(self):
        path = self.root / "crates/spiffe-source/src/source.rs"
        twin = self.root / "same-source.rs"
        twin.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(twin)
        self.check()

    def test_symlinked_source_with_drift_is_rejected(self):
        path = self.root / "crates/spiffe-source/src/source.rs"
        twin = self.root / "drifted-source.rs"
        twin.write_bytes(path.read_bytes() + b"\n// drift\n")
        path.unlink()
        path.symlink_to(twin)
        with self.assertRaisesRegex(SystemExit, "review source drift"):
            self.check()

    def test_removing_a_minimum_coverage_entry_is_rejected(self):
        path = self.root / "spec/formal/spiffe/coverage.json"
        data = json.loads(path.read_text())
        data["sources"].pop()
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(
            SystemExit, "manifest does not match reviewed-source attestation"
        ):
            self.check()


if __name__ == "__main__":
    unittest.main()
