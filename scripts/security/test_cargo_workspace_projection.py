"""Adversarial checks for the bounded authority workspace projection."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("workspace_projection_tested", ROOT / "scripts/security/cargo-workspace-projection.py")
projection = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = projection
SPEC.loader.exec_module(projection)


class WorkspaceProjectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = projection.read_toml(ROOT / "Cargo.toml")
        cls.package = projection.read_toml(ROOT / "crates/domain/Cargo.toml")
        cls.graph = projection.lock_projection.read_lock(ROOT / "Cargo.lock")

    def project(self, workspace=None, package=None):
        return projection.project(workspace or self.workspace, package or self.package,
                                  self.graph, "opensesame-domain", "crates/domain")

    def test_inherited_dependencies_and_unrelated_workspace_dependencies(self):
        baseline = self.project()
        unrelated = copy.deepcopy(self.workspace)
        unrelated["workspace"]["dependencies"]["tokio"]["features"].append("sync")
        self.assertEqual(self.project(unrelated), baseline)
        relevant = copy.deepcopy(self.workspace)
        relevant["workspace"]["dependencies"]["serde"]["features"].append("rc")
        self.assertNotEqual(self.project(relevant), baseline)
        self.assertIn("proptest", baseline["workspace"]["dependencies"])

    def test_aliases_and_all_target_and_dependency_tables(self):
        package = copy.deepcopy(self.package)
        package["build-dependencies"] = {"build-alias": {"workspace": True}}
        package["target"] = {"cfg(unix)": {"dev-dependencies": {"target-alias": {"workspace": True}}}}
        workspace = copy.deepcopy(self.workspace)
        workspace["workspace"]["dependencies"].update({
            "build-alias": {"package": "serde", "version": "1"},
            "target-alias": {"package": "uuid", "version": "1"},
        })
        baseline = self.project(workspace, package)
        selected = baseline["workspace"]["dependencies"]
        self.assertEqual(selected["build-alias"]["package"], "serde")
        self.assertEqual(selected["target-alias"]["package"], "uuid")
        workspace["workspace"]["dependencies"]["target-alias"]["version"] = "2"
        self.assertNotEqual(self.project(workspace, package), baseline)

    def test_legacy_dependency_table_spellings_and_duplicates(self):
        package = copy.deepcopy(self.package)
        package["dev_dependencies"] = package.pop("dev-dependencies")
        package["target"] = {"cfg(unix)": {"build_dependencies": {"serde": {"workspace": True}}}}
        baseline = self.project(self.workspace, package)
        self.assertIn("proptest", baseline["workspace"]["dependencies"])
        self.assertIn("serde", baseline["workspace"]["dependencies"])
        workspace = copy.deepcopy(self.workspace)
        workspace["workspace"]["dependencies"]["serde"]["features"].append("rc")
        self.assertNotEqual(self.project(workspace, package), baseline)
        package["dev-dependencies"] = {}
        with self.assertRaisesRegex(projection.ProjectionError, "duplicate dependency table"):
            self.project(workspace, package)
        del package["dev-dependencies"]
        package["target"]["cfg(unix)"]["build-dependencies"] = {}
        with self.assertRaisesRegex(projection.ProjectionError, "duplicate dependency table"):
            self.project(workspace, package)

    def test_member_selection_and_unsupported_patterns(self):
        baseline = self.project()
        unrelated = copy.deepcopy(self.workspace)
        unrelated["workspace"]["members"].append("crates/unrelated")
        self.assertEqual(self.project(unrelated), baseline)
        unrelated["workspace"]["members"].remove("crates/domain")
        self.assertNotEqual(self.project(unrelated), baseline)
        unrelated["workspace"]["members"].append("crates/*")
        with self.assertRaisesRegex(projection.ProjectionError, "unsupported member path"):
            self.project(unrelated)

    def test_only_inherited_workspace_package_fields_are_selected(self):
        baseline = self.project()
        unrelated = copy.deepcopy(self.workspace)
        unrelated["workspace"]["package"]["repository"] = "https://example.invalid/other"
        self.assertEqual(self.project(unrelated), baseline)
        relevant = copy.deepcopy(self.workspace)
        relevant["workspace"]["package"]["edition"] = "2024"
        self.assertNotEqual(self.project(relevant), baseline)

    def test_package_overrides_and_aliases_use_reachable_names(self):
        baseline = self.project()
        unrelated = copy.deepcopy(self.workspace)
        unrelated["patch"]["crates-io"]["askama_derive"]["rev"] = "f" * 40
        unrelated["profile"]["dev"]["package"]["opensesame-human-vault"]["opt-level"] = 2
        self.assertEqual(self.project(unrelated), baseline)
        relevant = copy.deepcopy(self.workspace)
        relevant["patch"]["crates-io"]["serde-alias"] = {"package": "serde", "git": "https://example.invalid/serde"}
        self.assertNotEqual(self.project(relevant), baseline)
        relevant = copy.deepcopy(self.workspace)
        relevant["profile"]["dev"]["package"]["sha2"]["opt-level"] = 2
        self.assertNotEqual(self.project(relevant), baseline)
        relevant = copy.deepcopy(self.workspace)
        relevant["profile"]["dev"]["package"]["*"] = {"opt-level": 1}
        self.assertNotEqual(self.project(relevant), baseline)
        relevant = copy.deepcopy(self.workspace)
        relevant["profile"]["dev"]["panic"] = "abort"
        self.assertNotEqual(self.project(relevant), baseline)

    def test_malformed_and_unsupported_inputs_fail_closed(self):
        changes = []
        missing = copy.deepcopy(self.workspace)
        del missing["workspace"]["dependencies"]["serde"]
        changes.append((missing, self.package))
        invalid = copy.deepcopy(self.package)
        invalid["dependencies"]["serde"] = {"workspace": "true"}
        changes.append((self.workspace, invalid))
        invalid = copy.deepcopy(self.package)
        invalid["target"] = {"cfg(unix)": {"dependencies": []}}
        changes.append((self.workspace, invalid))
        invalid = copy.deepcopy(self.workspace)
        invalid["workspace"]["dependencies"]["serde"] = {"versoin": "1"}
        changes.append((invalid, self.package))
        invalid = copy.deepcopy(self.workspace)
        invalid["profile"]["dev"]["package"]["https://example.invalid/#serde@1.0"] = {}
        changes.append((invalid, self.package))
        invalid = copy.deepcopy(self.workspace)
        invalid["patch"]["crates-io"]["serde"] = {"package": False}
        changes.append((invalid, self.package))
        for workspace, package in changes:
            with self.subTest(workspace=workspace, package=package), self.assertRaises(projection.ProjectionError):
                self.project(workspace, package)

    def test_local_dependency_sources_require_explicit_coverage(self):
        graph = copy.deepcopy(self.graph)
        dependency = projection.lock_projection.PackageId("local-helper", "0.1.0", "")
        graph.packages[dependency] = projection.lock_projection.Package(dependency, None, ())
        graph.edges[dependency] = ()
        root = graph.select("opensesame-domain")
        graph.edges[root] = (*graph.edges[root], dependency)
        with self.assertRaisesRegex(projection.ProjectionError, "path dependencies"):
            projection.project(self.workspace, self.package, graph, "opensesame-domain", "crates/domain")


if __name__ == "__main__":
    unittest.main()
