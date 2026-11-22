import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/audit"))
from cve_lite_tools import PINS, verify_tools


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class ToolPinTests(unittest.TestCase):
    def setUp(self):
        cve = ROOT / "node_modules/cve-lite-cli"
        if not cve.is_dir():
            cve = Path("/tmp/opensesame-cve-lite-tool/node_modules/cve-lite-cli")
        vitest = ROOT / "node_modules/vitest"
        if not cve.is_dir() or not vitest.is_dir():
            self.skipTest("install the pinned audit development dependencies")
        self.tmp = tempfile.TemporaryDirectory(prefix="cve-lite-tool-pin-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        modules = self.root / "node_modules"
        modules.mkdir()
        shutil.copytree(cve, modules / "cve-lite-cli", ignore=shutil.ignore_patterns("node_modules"))
        shutil.copytree(vitest, modules / "vitest", ignore=shutil.ignore_patterns("node_modules"))
        bins = modules / ".bin"
        bins.mkdir()
        for name, pin in PINS.items():
            (bins / pin["bin"]).symlink_to(modules / name / pin["entry"])
        deps = {name: pin["version"] for name, pin in PINS.items()}
        manifest = {"devDependencies": deps}
        packages = {"": manifest}
        for name, pin in PINS.items():
            packages[f"node_modules/{name}"] = {
                "version": pin["version"],
                "resolved": f"https://registry.npmjs.org/{name}/-/{name}-{pin['version']}.tgz",
                "integrity": pin["integrity"],
            }
        write_json(self.root / "package.json", manifest)
        write_json(self.root / "package-lock.json", {"packages": packages})

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def test_tool_contents_lock_integrity_and_bin_target_are_verified(self):
        verify_tools(self.root)
        scanner = self.root / "node_modules/cve-lite-cli/dist/index.js"
        original = scanner.read_bytes()
        scanner.write_bytes(original + b"\n// altered\n")
        with self.assertRaises(ValueError):
            verify_tools(self.root)
        scanner.write_bytes(original)
        vitest = self.root / "node_modules/vitest/vitest.mjs"
        original_vitest = vitest.read_bytes()
        vitest.write_bytes(original_vitest + b"\n// altered\n")
        with self.assertRaises(ValueError):
            verify_tools(self.root)
        vitest.write_bytes(original_vitest)
        binary = self.root / "node_modules/.bin/cve-lite"
        binary.unlink()
        binary.symlink_to(vitest)
        with self.assertRaises(ValueError):
            verify_tools(self.root)
        binary.unlink()
        binary.symlink_to(scanner)
        lock = json.loads((self.root / "package-lock.json").read_text())
        lock["packages"]["node_modules/cve-lite-cli"]["integrity"] = "sha512-tampered"
        write_json(self.root / "package-lock.json", lock)
        with self.assertRaises(ValueError):
            verify_tools(self.root)

    def test_gate_ignores_tool_overrides_and_reports_scanner_error(self):
        for source in ("scripts/audit/cve-lite-gate.sh", "scripts/audit/cve_lite_tools.py",
                       "scripts/lib/audit-directory.sh"):
            destination = self.root / source
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / source, destination)
        fake_bin = self.root.parent / "bin"
        fake_bin.mkdir()
        node = fake_bin / "node"
        node.write_text('#!/bin/sh\ncase "$1" in */.bin/vitest|*/vitest/vitest.mjs) exit 0;; *) exit 3;; esac\n')
        node.chmod(0o755)
        unexpected = fake_bin / "unexpected"
        marker = self.root.parent / "unexpected-ran"
        unexpected.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 0\n")
        unexpected.chmod(0o755)
        audit = self.root.parent / "audit"
        audit.mkdir(mode=0o700)
        env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "OPENSESAME_AUDIT_DIR": str(audit),
               "OPENSESAME_CVE_LITE_BIN": str(unexpected), "OPENSESAME_VITEST_BIN": str(unexpected)}
        result = subprocess.run(["bash", str(self.root / "scripts/audit/cve-lite-gate.sh")],
                                cwd=self.root, env=env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("scan exited 3", result.stderr)
        self.assertIn("cve-lite override hygiene", result.stdout)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
