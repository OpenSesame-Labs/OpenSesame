"""Isolated tests for scripts/security/cargo-lock-projection.py (no Cargo, no network)."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cargo_lock_projection", HERE / "cargo-lock-projection.py")
projection = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = projection
spec.loader.exec_module(projection)


def write_lock(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")


MINIMAL_ROOT = """\
version = 3

[[package]]
name = "opensesame-spiffe-source"
version = "0.1.0"
dependencies = ["spiffe"]

[[package]]
name = "spiffe"
version = "0.19.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
dependencies = []
"""


class CargoLockProjectionTest(unittest.TestCase):
    def test_cli_unchanged_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "Cargo.lock"
            write_lock(lock, MINIMAL_ROOT)
            result = subprocess.run(
                [
                    "python3",
                    str(HERE / "cargo-lock-projection.py"),
                    "--root",
                    "opensesame-spiffe-source",
                    str(lock),
                    str(lock),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"changed": False})

    def test_cli_detects_version_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = Path(tmp) / "before.lock"
            after = Path(tmp) / "after.lock"
            write_lock(before, MINIMAL_ROOT)
            write_lock(after, MINIMAL_ROOT.replace("0.19.0", "0.19.1", 1))
            result = subprocess.run(
                [
                    "python3",
                    str(HERE / "cargo-lock-projection.py"),
                    "--root",
                    "opensesame-spiffe-source",
                    "--dependency",
                    "spiffe",
                    str(before),
                    str(after),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"changed": True})

    def test_cli_rejects_malformed_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.lock"
            bad.write_text("version = 2\n", encoding="utf-8")
            good = Path(tmp) / "good.lock"
            write_lock(good, MINIMAL_ROOT)
            result = subprocess.run(
                [
                    "python3",
                    str(HERE / "cargo-lock-projection.py"),
                    "--root",
                    "opensesame-spiffe-source",
                    str(bad),
                    str(good),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), "")

    def test_allow_absent_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            absent = Path(tmp) / "absent.lock"
            write_lock(absent, MINIMAL_ROOT.replace("opensesame-spiffe-source", "other-root", 1))
            present = Path(tmp) / "present.lock"
            write_lock(present, MINIMAL_ROOT)
            result = subprocess.run(
                [
                    "python3",
                    str(HERE / "cargo-lock-projection.py"),
                    "--root",
                    "opensesame-spiffe-source",
                    "--allow-absent",
                    str(absent),
                    str(present),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"changed": True})

    def test_projection_sha256_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "Cargo.lock"
            write_lock(lock, MINIMAL_ROOT)
            graph = projection.read_lock(lock)
            first = projection.projection_sha256(graph, "opensesame-spiffe-source")
            second = projection.projection_sha256(graph, "opensesame-spiffe-source")
            self.assertEqual(first, second)
            self.assertEqual(len(first), 64)


if __name__ == "__main__":
    unittest.main()