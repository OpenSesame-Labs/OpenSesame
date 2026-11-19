#!/usr/bin/env python3
"""Exercise source-lifetime drift checks without modifying a live worktree."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
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
        for name in [*(item["path"] for item in data["sources"]), "Cargo.lock",
                     "spec/formal/spiffe/coverage.json"]:
            source, target = ROOT / name, self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.checker.main()

    def test_reviewed_inputs_pass(self):
        self.check()

    def test_added_build_script_is_rejected(self):
        (self.root / "crates/spiffe-source/build.rs").write_text("fn main() {}\n")
        with self.assertRaisesRegex(SystemExit, "optional source/build-script drift"):
            self.check()

    def test_same_bytes_symlinked_source_is_rejected(self):
        path = self.root / "crates/spiffe-source/src/source.rs"
        twin = self.root / "same-source.rs"
        twin.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(twin)
        with self.assertRaisesRegex(SystemExit, "not a regular file or directory"):
            self.check()

    def test_removing_a_minimum_coverage_entry_is_rejected(self):
        path = self.root / "spec/formal/spiffe/coverage.json"
        data = json.loads(path.read_text())
        data["sources"].pop()
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(SystemExit, "invalid reviewed source manifest"):
            self.check()


if __name__ == "__main__":
    unittest.main()
