import base64
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCAN_REPORT = ROOT / "scripts/audit/cve-lite-scan-report.py"
OVERRIDE_REPORT = ROOT / "scripts/audit/cve-lite-override-report.py"
OVERRIDES = ROOT / "scripts/audit/cve-lite-overrides.mjs"
SKIPPED = [
    {"ruleId": "OA007", "reason": "requires --check-network"},
    {"ruleId": "OA010", "reason": "requires --check-network"},
]


def run(*args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def clean_scan():
    return {
        "cliVersion": "1.41.4", "mode": "resolved-lockfile", "source": "package-lock",
        "packageCount": 4, "findingCount": 0, "findings": [], "status": "ok",
        "complete": True, "diagnostics": [], "skippedDependencies": [],
    }


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cve-lite-test-")
        self.root = Path(self.tmp.name)
        self.report = self.root / "report.json"
        write_json(self.root / "package.json", {"name": "root", "overrides": {}})
        write_json(self.root / "package-lock.json", {"packages": {}})
        write_json(self.root / "scripts/audit/cve-lite-preventive-overrides.json", {"absent": []})

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, report, status=0):
        write_json(self.report, report)
        return run("python3", str(SCAN_REPORT), str(self.report), str(status))

    def override(self, report, executable=None):
        write_json(self.report, report)
        args = ["python3", str(OVERRIDE_REPORT), str(self.root), str(self.report)]
        if executable:
            args.append(str(executable))
        return run(*args)

    def empty_overrides(self):
        return {"findings": [], "imports": {}, "scannedFiles": 1, "skippedOverrideRules": SKIPPED}

    def test_scan_fails_on_hidden_findings_errors_and_incomplete_detection(self):
        self.assertEqual(self.scan(clean_scan()).returncode, 0)
        for change, status in [
            ({"findingCount": 0, "findings": [{"package": "bad"}]}, 0),
            ({"findingCount": 1, "findings": [{"package": "bad"}]}, 1),
            ({"cliVersion": "1.41.3"}, 0),
            ({"packageCount": 0}, 0),
            ({"skippedDependencies": [{"name": "bad"}]}, 0),
            ({"complete": False, "status": "partial", "diagnostics": [
                {"code": "OSV_REQUEST_FAILURE", "impact": "detection"}]}, 0),
        ]:
            self.assertNotEqual(self.scan({**clean_scan(), **change}, status).returncode, 0)
        self.assertNotEqual(self.scan(clean_scan(), 3).returncode, 0)

    def test_only_explicit_remediation_only_diagnostic_is_allowed(self):
        report = {**clean_scan(), "complete": False, "status": "partial", "diagnostics": [
            {"code": "PACKUMENT_FETCH_FAILURE", "impact": "remediation", "severity": "warning", "count": 1}]}
        self.assertEqual(self.scan(report).returncode, 0)
        report["diagnostics"][0]["severity"] = "error"
        self.assertNotEqual(self.scan(report).returncode, 0)
        report["diagnostics"][0]["severity"] = "warning"
        report["diagnostics"][0]["impact"] = "detection"
        self.assertNotEqual(self.scan(report).returncode, 0)

    def test_unknown_skipped_override_rules_and_malformed_reports_fail(self):
        self.assertEqual(self.override(self.empty_overrides()).returncode, 0)
        report = self.empty_overrides()
        report["skippedOverrideRules"] = SKIPPED + [{"ruleId": "OA008", "reason": "node_modules missing"}]
        self.assertNotEqual(self.override(report).returncode, 0)
        report["findings"] = [None]
        self.assertNotEqual(self.override(report).returncode, 0)

    def test_phantom_validation_checks_all_importers_not_only_first_three(self):
        write_json(self.root / "apps/good/package.json", {"devDependencies": {"missing": "1.0.0"}})
        write_json(self.root / "apps/bad/package.json", {})
        paths = [f"apps/good/tests/{i}.mjs" for i in range(3)] + ["apps/bad/tests/fourth.mjs"]
        for path in paths:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text('require("missing")')
        report = self.empty_overrides()
        report["findings"] = [{"ruleId": "PD002", "package": {"name": "missing"}}]
        report["imports"] = {"missing": paths}
        result = self.override(report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apps/bad/tests/fourth.mjs", result.stdout)
        write_json(self.root / "apps/bad/package.json", {"dependencies": {"missing": "1.0.0"}})
        self.assertEqual(self.override(report).returncode, 0)
        report["imports"]["missing"].append("../../outside.js")
        self.assertNotEqual(self.override(report).returncode, 0)

    def test_file_alias_requires_correct_package_and_tarball_integrity(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            content = b'{"name":"picomatch","version":"2.3.2"}'
            item = tarfile.TarInfo("package/package.json")
            item.size = len(content)
            archive.addfile(item, io.BytesIO(content))
        archive_path = self.root / "package.tgz"
        archive_path.write_bytes(data.getvalue())
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(data.getvalue()).digest()).decode()
        write_json(self.root / "package.json", {"devDependencies": {"alias": "file:package.tgz"},
            "overrides": {"picomatch@^2": "$alias"}})
        write_json(self.root / "package-lock.json", {"packages": {"node_modules/alias": {
            "version": "2.3.2", "resolved": "file:package.tgz", "integrity": integrity}}})
        report = self.empty_overrides()
        report["findings"] = [{"ruleId": "OA002", "package": {"name": "picomatch"},
            "location": {"jsonPath": "/overrides/picomatch@^2"}}]
        self.assertEqual(self.override(report).returncode, 0)
        report["findings"][0]["package"]["name"] = "other"
        self.assertNotEqual(self.override(report).returncode, 0)
        report["findings"][0]["package"]["name"] = "picomatch"
        archive_path.write_bytes(b"tampered")
        self.assertNotEqual(self.override(report).returncode, 0)

    def test_scoped_override_requires_every_edge_to_satisfy_the_parent(self):
        parent = self.root / "node_modules/parent/package.json"
        child = self.root / "node_modules/child/package.json"
        write_json(parent, {"name": "parent", "version": "1.0.0", "dependencies": {"child": "^0.8.5"}})
        write_json(child, {"name": "child", "version": "0.8.15"})
        write_json(self.root / "package.json", {"overrides": {"parent": {"child": "0.8.15"}}})
        lock = {"packages": {"node_modules/parent": {"version": "1.0.0"},
                             "node_modules/child": {"version": "0.8.15"}}}
        write_json(self.root / "package-lock.json", lock)
        report = self.empty_overrides()
        report["findings"] = [{"ruleId": "OA005", "subRuleId": "OA005.d",
            "package": {"name": "parent"}, "location": {"jsonPath": "/overrides/parent"},
            "details": "Override forces child to 0.8.15 only when installed via parent. Another tree path installed 0.9.0."}]
        self.assertEqual(self.override(report).returncode, 0)
        finding = report["findings"][0]
        finding["subRuleId"] = "OA005.e"
        finding["details"] = "Nested override parent.child is valid and effective. A flat top-level override could be used."
        self.assertEqual(self.override(report).returncode, 0)
        child.unlink()
        self.assertNotEqual(self.override(report).returncode, 0)
        write_json(child, {"name": "child", "version": "0.8.15"})
        finding["subRuleId"] = "OA005.d"
        finding["details"] = "Override forces child to 0.8.15 only when installed via parent. Another tree path installed 0.9.0."
        write_json(parent, {"name": "parent", "version": "1.0.0", "dependencies": {"child": "^0.7.4"}})
        self.assertNotEqual(self.override(report).returncode, 0)
        write_json(parent, {"name": "parent", "version": "1.0.0", "dependencies": {"child": ">=0.8.0 <1.0.0"}})
        self.assertNotEqual(self.override(report).returncode, 0)
        write_json(parent, {"name": "parent", "version": "1.0.0", "dependencies": {"child": "^0.8.5"}})
        lock["packages"]["node_modules/another/node_modules/parent"] = {"version": "1.0.0"}
        write_json(self.root / "package-lock.json", lock)
        self.assertNotEqual(self.override(report).returncode, 0)

    def test_version_qualified_override_checks_matching_parent_edges(self):
        semver = ROOT / "node_modules/semver"
        if not (semver / "package.json").is_file():
            self.skipTest("install the lockfile dependencies to run the semver proof")
        tool = self.root / "tool"
        write_json(tool / "package.json", {"name": "cve-lite-cli", "version": "1.41.4"})
        executable = tool / "dist/index.js"
        executable.parent.mkdir(parents=True)
        executable.write_text("")
        (tool / "node_modules").mkdir()
        (tool / "node_modules/semver").symlink_to(semver, target_is_directory=True)
        write_json(self.root / "package.json", {"overrides": {"child@^7": "7.3.0"}})
        lock = {"packages": {}}
        for parent, spec, version in [("one", "^7.1.0", "7.3.0"), ("two", "^6.1.0", "6.2.0")]:
            location = f"node_modules/{parent}"
            entry = {"name": parent, "version": "1.0.0", "dependencies": {"child": spec}}
            write_json(self.root / location / "package.json", entry)
            lock["packages"][location] = {"version": "1.0.0", "dependencies": {"child": spec}}
            child_location = f"{location}/node_modules/child"
            write_json(self.root / child_location / "package.json", {"name": "child", "version": version})
            lock["packages"][child_location] = {"version": version}
        write_json(self.root / "package-lock.json", lock)
        report = self.empty_overrides()
        report["findings"] = [{"ruleId": "OA008", "package": {"name": "child"},
            "location": {"jsonPath": "/overrides/child@^7"}, "details": "other scoped version"}]
        self.assertEqual(self.override(report, executable).returncode, 0)
        one = self.root / "node_modules/one/node_modules/child/package.json"
        write_json(one, {"name": "child", "version": "7.2.0"})
        lock["packages"]["node_modules/one/node_modules/child"]["version"] = "7.2.0"
        write_json(self.root / "package-lock.json", lock)
        self.assertNotEqual(self.override(report, executable).returncode, 0)
        write_json(one, {"name": "child", "version": "7.3.0"})
        lock["packages"]["node_modules/one/node_modules/child"]["version"] = "7.3.0"
        parent = self.root / "node_modules/one/package.json"
        write_json(parent, {"name": "one", "version": "1.0.0", "dependencies": {"child": "^7.4.0"}})
        lock["packages"]["node_modules/one"]["dependencies"]["child"] = "^7.4.0"
        write_json(self.root / "package-lock.json", lock)
        self.assertNotEqual(self.override(report, executable).returncode, 0)
        report["findings"] = []
        result = self.override(report, executable)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires child ^7.4.0, resolved 7.3.0", result.stdout)

    def test_future_pin_requires_exact_policy_and_fails_when_target_returns(self):
        manifest = {"overrides": {"future": "1.2.3"}}
        write_json(self.root / "package.json", manifest)
        policy = {"absent": [{"path": "/overrides/future", "package": "future",
                              "value": "1.2.3", "reason": "GHSA-reviewed-override"}]}
        write_json(self.root / "scripts/audit/cve-lite-preventive-overrides.json", policy)
        report = self.empty_overrides()
        report["findings"] = [{"ruleId": "OA001", "package": {"name": "future"},
                               "location": {"jsonPath": "/overrides/future"}}]
        self.assertEqual(self.override(report).returncode, 0)
        manifest["overrides"]["future"] = "1.2.4"
        write_json(self.root / "package.json", manifest)
        self.assertNotEqual(self.override(report).returncode, 0)
        manifest["overrides"]["future"] = "1.2.3"
        write_json(self.root / "package.json", manifest)
        write_json(self.root / "package-lock.json", {"packages": {"node_modules/future": {"version": "1.2.3"}}})
        report["findings"] = []
        self.assertNotEqual(self.override(report).returncode, 0)
        write_json(self.root / "package-lock.json", {"packages": {}})
        write_json(self.root / "node_modules/future/package.json", {"name": "future", "version": "1.2.3"})
        self.assertNotEqual(self.override(report).returncode, 0)

    def test_future_parent_only_classifies_its_exact_absent_child_finding(self):
        value = {"child": "1.2.3"}
        write_json(self.root / "package.json", {"overrides": {"future-parent": value}})
        policy = {"absent": [{"path": "/overrides/future-parent", "package": "future-parent",
                              "value": value, "reason": "reviewed dependency security fix"}]}
        write_json(self.root / "scripts/audit/cve-lite-preventive-overrides.json", policy)
        report = self.empty_overrides()
        finding = {"ruleId": "OA005", "subRuleId": "OA005.b", "package": {"name": "future-parent"},
                   "location": {"jsonPath": "/overrides/future-parent"},
                   "details": 'Outer parent future-parent is not in the dependency tree. '
                              'The nested override "child" has no parent to apply to.'}
        report["findings"] = [finding]
        self.assertEqual(self.override(report).returncode, 0)
        finding["subRuleId"] = "OA005.c"
        self.assertNotEqual(self.override(report).returncode, 0)
        finding["subRuleId"] = "OA005.b"
        finding["details"] = finding["details"].replace('"child"', '"other"')
        self.assertNotEqual(self.override(report).returncode, 0)

    def test_version_qualified_file_alias_requires_each_matching_consumer(self):
        semver = ROOT / "node_modules/semver"
        if not (semver / "package.json").is_file():
            self.skipTest("install the lockfile dependencies to run the semver proof")
        tool = self.root / "tool"
        write_json(tool / "package.json", {"name": "cve-lite-cli", "version": "1.41.4"})
        executable = tool / "dist/index.js"
        executable.parent.mkdir(parents=True)
        executable.write_text("")
        (tool / "node_modules").mkdir()
        (tool / "node_modules/semver").symlink_to(semver, target_is_directory=True)
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            content = b'{"name":"child","version":"2.3.2"}'
            item = tarfile.TarInfo("package/package.json")
            item.size = len(content)
            archive.addfile(item, io.BytesIO(content))
        archive_path = self.root / "child.tgz"
        archive_path.write_bytes(data.getvalue())
        digest = "sha512-" + base64.b64encode(hashlib.sha512(data.getvalue()).digest()).decode()
        manifest = {"devDependencies": {"child": "file:child.tgz"}, "overrides": {"child@^2": "$child"}}
        write_json(self.root / "package.json", manifest)
        write_json(self.root / "node_modules/child/package.json", {"name": "child", "version": "2.3.2"})
        parent = {"name": "parent", "version": "1.0.0", "dependencies": {"child": "^2.0.0"}}
        write_json(self.root / "node_modules/parent/package.json", parent)
        lock = {"packages": {"": manifest, "node_modules/parent": parent,
            "node_modules/child": {"version": "2.3.2", "resolved": "file:child.tgz", "integrity": digest}}}
        write_json(self.root / "package-lock.json", lock)
        report = self.empty_overrides()
        report["findings"] = [{"ruleId": "OA006", "package": {"name": "child"},
            "location": {"jsonPath": "/overrides/child@^2"}, "details": "scoped alias"}]
        self.assertEqual(self.override(report, executable).returncode, 0)
        parent["dependencies"]["child"] = "^2.4.0"
        write_json(self.root / "node_modules/parent/package.json", parent)
        write_json(self.root / "package-lock.json", lock)
        self.assertNotEqual(self.override(report, executable).returncode, 0)
        parent["dependencies"]["child"] = "^2.0.0"
        write_json(self.root / "node_modules/parent/package.json", parent)
        write_json(self.root / "package-lock.json", lock)
        archive_path.write_bytes(b"tampered")
        self.assertNotEqual(self.override(report, executable).returncode, 0)


class CoverageTests(unittest.TestCase):
    def test_full_import_coverage_over_scanner_cap(self):
        with tempfile.TemporaryDirectory(prefix="cve-lite-coverage-test-") as directory:
            base = Path(directory)
            project = base / "project"
            src = project / "src"
            src.mkdir(parents=True)
            initialized = run("git", "init", "-q", str(project))
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            for i in range(5001):
                (src / f"{i:05}.js").write_text('require("sentinel")' if i == 5000 else "const x = 1;")
            (project / "tests").mkdir()
            (project / "tests/real.js").write_text('require("from-tests")')
            (project / "tests/fixtures").mkdir()
            (project / "tests/fixtures/ignored.js").write_text('require("ignored")')
            (project / ".hidden").mkdir()
            (project / ".hidden/real.js").write_text('require("from-hidden")')
            tool = base / "tool"
            write_json(tool / "package.json", {"name": "cve-lite-cli", "version": "1.41.4", "type": "module"})
            modules = {
                "dist/index.js": "",
                "dist/constants.js": "export const EXCLUDED_DIRS = new Set(['node_modules']);",
                "dist/utils/node-builtins.js": "export const isNodeBuiltinSpecifier = () => false;",
                "dist/audit-log/index.js": "export const NULL_AUDIT_LOG = {};",
                "dist/overrides/index.js": "export const buildOverrideContext = () => ({});\n"
                    "export const audit = async ctx => ({findings: [], skippedDetectors: []});",
                "dist/usage/scanner.js": "import fs from 'node:fs';\n"
                    "export const MAX_FILES_TO_SCAN = 5000;\n"
                    "export function scanAllImports(dir) { const files = fs.readdirSync(dir); "
                    "const imports = new Map(); for (const file of files) "
                    "for (const m of fs.readFileSync(dir + '/' + file, 'utf8').matchAll(/require\\(\"([^\"]+)\"\\)/g)) "
                    "imports.set(m[1], [...(imports.get(m[1]) ?? []), file]); "
                    "return { imports, scannedFiles: files.length, truncated: files.length > 5000 }; }",
            }
            for name, content in modules.items():
                file = tool / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(content)
            audit = base / "audit"
            audit.mkdir()
            result = run("node", str(OVERRIDES), str(project), str(tool / "dist/index.js"), str(audit))
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((audit / "cve-lite-overrides.json").read_text())
            self.assertEqual(report["scannedFiles"], 5003)
            self.assertEqual(report["imports"]["sentinel"], ["src/05000.js"])
            self.assertEqual(report["imports"]["from-tests"], ["tests/real.js"])
            self.assertEqual(report["imports"]["from-hidden"], [".hidden/real.js"])
            self.assertNotIn("ignored", report["imports"])

if __name__ == "__main__":
    unittest.main()
