"""Forged timestamp bytecode must not replace proof projection source."""

import importlib.util
import json
import marshal
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
_SCRATCH = importlib.util.spec_from_file_location("formal_scratch_checkout", ROOT / "scripts/security/formal_scratch_checkout.py")
scratch = importlib.util.module_from_spec(_SCRATCH)
_SCRATCH.loader.exec_module(scratch)
LOCK = "scripts/security/cargo-lock-projection.py"
WORKSPACE = "scripts/security/cargo-workspace-projection.py"
MULTI = "scripts/security/cargo-workspace-multipackage.py"
CHECKERS = (
    "spec/formal/authority/check-drift.py",
    "spec/formal/spiffe/check-drift.py",
    "spec/formal/source-lifetime/check-drift.py",
)


class BytecodeIntegrityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="projection-pyc-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name) / "repo"
        paths = {LOCK, WORKSPACE, MULTI, "Cargo.toml", "Cargo.lock", *CHECKERS}
        for checker in CHECKERS:
            paths |= scratch.coverage_files(ROOT, str(Path(checker).with_name("coverage.json")))
        scratch.copy_files(ROOT, cls.root, paths)
        # The checkers resolve reviewed lineage and blobs in their own checkout.
        scratch.init_checkout(cls.root, ROOT)

    def run_python(self, *args):
        return subprocess.run([sys.executable, "-I", "-B", *map(str, args)], cwd=self.root,
                              env=scratch.scrubbed_env(), text=True, capture_output=True, check=False)

    def forge(self, name):
        source = self.root / name
        cache = source.parent / "__pycache__" / f"{source.stem}.{sys.implementation.cache_tag}.pyc"
        cache.parent.mkdir(exist_ok=True)
        info = source.stat()
        header = importlib.util.MAGIC_NUMBER + struct.pack("<III", 0, int(info.st_mtime) & 0xffffffff,
                                                           info.st_size & 0xffffffff)
        cache.write_bytes(header + marshal.dumps(compile("raise SystemExit(71)", str(source), "exec")))
        probe = ("import importlib.util,sys; "
                 "s=importlib.util.spec_from_file_location('probe',sys.argv[1]); "
                 "m=importlib.util.module_from_spec(s); s.loader.exec_module(m)")
        result = self.run_python("-c", probe, source)
        self.assertEqual(result.returncode, 71, result.stderr)
        self.addCleanup(cache.unlink, missing_ok=True)
        return cache

    def test_forged_matching_timestamp_and_size_cannot_replace_projector_source(self):
        cases = [
            (WORKSPACE, LOCK, "usage:"),
            (MULTI, WORKSPACE, "usage:"),
            (MULTI, LOCK, "usage:"),
            (CHECKERS[0], WORKSPACE, "authority-formal:"),
            (CHECKERS[0], LOCK, "authority-formal:"),
            (CHECKERS[1], LOCK, "spiffe-formal:"),
            (CHECKERS[2], LOCK, "source-lifetime-formal:"),
        ]
        for command, forged, expected in cases:
            with self.subTest(command=command, forged=forged):
                cache = self.forge(forged)
                args = [self.root / command]
                if command in (WORKSPACE, MULTI):
                    args.append("--help")
                result = self.run_python(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout)
                cache.unlink()

    def test_drift_still_fails_with_forged_bytecode_present(self):
        for checker in CHECKERS:
            with self.subTest(checker=checker):
                cache = self.forge(LOCK)
                coverage = json.loads((self.root / Path(checker).with_name("coverage.json")).read_text())
                path = self.root / coverage["sources"][0]["path"]
                original = path.read_bytes()
                try:
                    path.write_bytes(original + b"\n# forged cache drift control\n")
                    result = self.run_python(self.root / checker)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn("drift", result.stderr.lower())
                finally:
                    path.write_bytes(original)
                    cache.unlink()

    def test_nonregular_imported_helpers_are_rejected(self):
        for command, dependency in [(WORKSPACE, LOCK), (MULTI, WORKSPACE),
                                    (CHECKERS[0], WORKSPACE), (CHECKERS[1], LOCK),
                                    (CHECKERS[2], LOCK)]:
            with self.subTest(command=command):
                source = self.root / dependency
                moved = source.with_suffix(".saved")
                source.rename(moved)
                source.symlink_to(moved.name)
                try:
                    args = [self.root / command]
                    if command in (WORKSPACE, MULTI):
                        args.append("--help")
                    result = self.run_python(*args)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn("regular", result.stderr.lower())
                finally:
                    source.unlink()
                    moved.rename(source)


if __name__ == "__main__":
    unittest.main()
