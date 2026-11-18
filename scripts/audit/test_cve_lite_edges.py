import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/audit"))
from cve_lite_edges import consumer_edges


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class ConsumerEdgeTests(unittest.TestCase):
    def setUp(self):
        semver = ROOT / "node_modules/semver"
        if not (semver / "package.json").is_file():
            self.skipTest("install the lockfile dependencies")
        self.tmp = tempfile.TemporaryDirectory(prefix="cve-lite-edges-")
        self.root = Path(self.tmp.name)
        tool = self.root / "tool"
        write_json(tool / "package.json", {"name": "cve-lite-cli", "version": "1.41.4"})
        self.executable = tool / "dist/index.js"
        self.executable.parent.mkdir(parents=True)
        self.executable.write_text("")
        (tool / "node_modules").mkdir()
        (tool / "node_modules/semver").symlink_to(semver, target_is_directory=True)

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def test_major_mismatch_blocks_without_an_override_finding(self):
        manifest = {"overrides": {"glob": "14.0.2"}}
        write_json(self.root / "package.json", manifest)
        parent = {"name": "consumer", "version": "1.0.0", "dependencies": {"glob": "^13.0.1"}}
        write_json(self.root / "node_modules/consumer/package.json", parent)
        write_json(self.root / "node_modules/glob/package.json", {"name": "glob", "version": "14.0.2"})
        lock = {"packages": {"": manifest, "node_modules/consumer": parent,
                             "node_modules/glob": {"version": "14.0.2"}}}
        errors = consumer_edges(self.root, manifest, lock, self.executable)
        self.assertTrue(any("requires glob ^13.0.1, resolved 14.0.2" in error for error in errors))
        parent["dependencies"]["glob"] = "^14.0.0"
        write_json(self.root / "node_modules/consumer/package.json", parent)
        self.assertEqual(consumer_edges(self.root, manifest, lock, self.executable), [])
        parent["dependencies"]["glob"] = "unreviewed-tag"
        write_json(self.root / "node_modules/consumer/package.json", parent)
        self.assertTrue(consumer_edges(self.root, manifest, lock, self.executable))

    def test_npm_alias_checks_real_package_identity_and_version(self):
        spec = "npm:@typescript/typescript6@6.0.2"
        manifest = {"overrides": {"bundler": {"typescript": "6.0.3"}},
                    "devDependencies": {"typescript": spec}}
        write_json(self.root / "package.json", manifest)
        package = {"name": "@typescript/typescript6", "version": "6.0.2"}
        write_json(self.root / "node_modules/typescript/package.json", package)
        lock = {"packages": {"": manifest, "node_modules/typescript": {"version": "6.0.2"}}}
        self.assertEqual(consumer_edges(self.root, manifest, lock, self.executable), [])
        package["name"] = "unexpected"
        write_json(self.root / "node_modules/typescript/package.json", package)
        self.assertTrue(consumer_edges(self.root, manifest, lock, self.executable))

    def test_missing_optional_is_allowed_but_required_dependency_blocks(self):
        manifest = {"overrides": {"child": "1.2.3"}}
        write_json(self.root / "package.json", manifest)
        parent = {"name": "parent", "version": "1.0.0", "optionalDependencies": {"child": "^1.0.0"}}
        write_json(self.root / "node_modules/parent/package.json", parent)
        lock = {"packages": {"": manifest, "node_modules/parent": parent}}
        self.assertEqual(consumer_edges(self.root, manifest, lock, self.executable), [])
        parent["dependencies"] = parent.pop("optionalDependencies")
        write_json(self.root / "node_modules/parent/package.json", parent)
        errors = consumer_edges(self.root, manifest, lock, self.executable)
        self.assertTrue(any("missing dependency" in error for error in errors))

    def test_exact_root_override_may_normalize_only_the_lockfile_edge(self):
        manifest = {"overrides": {"child": "4.6.7"}}
        parent = {"name": "parent", "version": "1.0.0", "dependencies": {"child": "^4.6.7"}}
        write_json(self.root / "package.json", manifest)
        write_json(self.root / "node_modules/parent/package.json", parent)
        write_json(self.root / "node_modules/child/package.json", {"name": "child", "version": "4.6.7"})
        locked_parent = {**parent, "dependencies": {"child": "4.6.7"}}
        lock = {"packages": {"": manifest, "node_modules/parent": locked_parent,
                             "node_modules/child": {"version": "4.6.7"}}}
        self.assertEqual(consumer_edges(self.root, manifest, lock, self.executable), [])
        manifest["overrides"]["child"] = "4.6.8"
        self.assertTrue(any("differs from lockfile" in error for error in
                            consumer_edges(self.root, manifest, lock, self.executable)))

    def test_promptfoo_hono_exception_is_bound_to_exact_provenance(self):
        manifest = {"overrides": {"promptfoo": {"@hono/node-server": "2.1.6"}}}
        parent = {"name": "promptfoo", "version": "0.125.1",
                  "dependencies": {"@hono/node-server": "2.1.5"}}
        child = {"name": "@hono/node-server", "version": "2.1.6"}
        write_json(self.root / "package.json", manifest)
        write_json(self.root / "node_modules/promptfoo/package.json", parent)
        write_json(self.root / "node_modules/@hono/node-server/package.json", child)
        regression = self.root / "scripts/security/dependency-override-upgrade.test.mjs"
        regression.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / "scripts/security/dependency-override-upgrade.test.mjs", regression)
        lock = {"packages": {
            "": manifest,
            "node_modules/promptfoo": {
                "version": "0.125.1",
                "resolved": "https://registry.npmjs.org/promptfoo/-/promptfoo-0.125.1.tgz",
                "integrity": "sha512-nogBhixdp69icwkg1EI0syZ4zAmAjJyWeLcqxAkTldbHi0qirOslwHvkUQhQmg65lQLrIKyMOMLXlBlSc6LRrg==",
                "dependencies": {"@hono/node-server": "2.1.5"},
            },
            "node_modules/@hono/node-server": {
                "version": "2.1.6",
                "resolved": "https://registry.npmjs.org/@hono/node-server/-/node-server-2.1.6.tgz",
                "integrity": "sha512-p/KH9MnfNcsm3sR6x4lNgm5j+QN4Et8srKredl9DZfXiyZ1UQ3aQ2YVpFLbqktYN5JI+DB+VZFKM2PqE5hLKjQ==",
            },
        }}
        self.assertEqual(consumer_edges(self.root, manifest, lock, self.executable), [])
        lock["packages"]["node_modules/@hono/node-server"]["integrity"] = "sha512-drift"
        self.assertTrue(any("requires @hono/node-server" in error for error in
                            consumer_edges(self.root, manifest, lock, self.executable)))

    def test_returning_future_pin_does_not_hide_other_consumer_errors(self):
        manifest = {"overrides": {"glob": "14.0.2", "future": "1.0.0"}}
        parent = {"name": "consumer", "version": "1.0.0", "dependencies": {"glob": "^13.0.0"}}
        write_json(self.root / "package.json", manifest)
        write_json(self.root / "node_modules/consumer/package.json", parent)
        write_json(self.root / "node_modules/glob/package.json", {"name": "glob", "version": "14.0.2"})
        write_json(self.root / "node_modules/future/package.json", {"name": "future", "version": "1.0.0"})
        lock = {"packages": {"": manifest, "node_modules/consumer": parent,
                             "node_modules/glob": {"version": "14.0.2"},
                             "node_modules/future": {"version": "1.0.0"}}}
        write_json(self.root / "package-lock.json", lock)
        write_json(self.root / "scripts/audit/cve-lite-preventive-overrides.json", {"absent": [
            {"path": "/overrides/future", "package": "future", "value": "1.0.0", "reason": "reviewed"}]})
        report = self.root / "report.json"
        write_json(report, {"findings": [], "imports": {}, "scannedFiles": 1,
                            "skippedOverrideRules": [
                                {"ruleId": "OA007", "reason": "requires --check-network"},
                                {"ruleId": "OA010", "reason": "requires --check-network"}]})
        result = subprocess.run(["python3", str(ROOT / "scripts/audit/cve-lite-override-report.py"),
                                 str(self.root), str(report), str(self.executable)], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("preventive override target returned: future", result.stdout)
        self.assertIn("requires glob ^13.0.0, resolved 14.0.2", result.stdout)


if __name__ == "__main__":
    unittest.main()
