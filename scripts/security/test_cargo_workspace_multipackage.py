"""Multi-package Cargo manifest projection and path-substitution controls."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("multipackage_projection_tested", ROOT / "scripts/security/cargo-workspace-multipackage.py")
projection = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = projection
SPEC.loader.exec_module(projection)


def fixture():
    workspace = {
        "workspace": {
            "members": ["crates/root", "crates/lib"],
            "resolver": "2",
            "package": {"version": "0.1.0", "edition": "2021", "repository": "unused"},
            "dependencies": {
                "local-alias": {"package": "local-lib", "path": "crates/lib"},
                "serde": {"version": "1", "features": ["derive"]},
                "unused": "1",
            },
        }
    }
    manifests = {
        "crates/root/Cargo.toml": {
            "package": {"name": "local-root", "version": {"workspace": True}},
            "dependencies": {"local-alias": {"workspace": True}},
        },
        "crates/lib/Cargo.toml": {
            "package": {"name": "local-lib", "version": {"workspace": True}, "edition": {"workspace": True}},
            "dependencies": {"serde": {"workspace": True}},
        },
        "crates/future/Cargo.toml": None,
        "crates/Cargo.toml": None,
    }
    graph = projection.lock_projection.LockGraph({
        "version": 4,
        "package": [
            {"name": "local-root", "version": "0.1.0", "dependencies": ["local-lib"]},
            {"name": "local-lib", "version": "0.1.0", "dependencies": ["serde"]},
            {"name": "serde", "version": "1.0.0", "source": "registry+https://example.invalid/index", "checksum": "a" * 64},
        ],
    })
    return workspace, manifests, graph


class MultipackageProjectionTest(unittest.TestCase):
    def setUp(self):
        self.workspace, self.manifests, self.graph = fixture()

    def project(self):
        return projection.project(self.workspace, self.manifests, self.graph,
                                  "local-root", "crates/root/Cargo.toml")

    def test_union_of_inherited_inputs_and_unrelated_changes(self):
        baseline = self.project()
        self.assertEqual(set(baseline["workspace"]["dependencies"]), {"local-alias", "serde"})
        self.assertEqual(set(baseline["workspace"]["package"]), {"version", "edition"})
        self.workspace["workspace"]["dependencies"]["unused"] = "2"
        self.workspace["workspace"]["members"].append("crates/other")
        self.assertEqual(self.project(), baseline)
        self.workspace["workspace"]["dependencies"]["serde"]["features"].append("rc")
        self.assertNotEqual(self.project(), baseline)

    def test_target_build_and_dev_inheritance_is_included(self):
        lib = self.manifests["crates/lib/Cargo.toml"]
        lib["target"] = {"cfg(unix)": {"build-dependencies": {"serde": {"workspace": True}}}}
        lib["dev-dependencies"] = {"serde": {"workspace": True}}
        self.assertIn("serde", self.project()["workspace"]["dependencies"])
        del self.workspace["workspace"]["dependencies"]["serde"]
        with self.assertRaisesRegex(projection.ProjectionError, "inherited dependency"):
            self.project()

    def test_workspace_lints_are_included_if_any_local_package_inherits(self):
        self.manifests["crates/lib/Cargo.toml"]["lints"] = {"workspace": True}
        with self.assertRaisesRegex(projection.ProjectionError, "workspace.lints"):
            self.project()
        self.workspace["workspace"]["lints"] = {"rust": {"unsafe_code": "forbid"}}
        first = self.project()
        self.workspace["workspace"]["lints"]["rust"]["unsafe_code"] = "deny"
        self.assertNotEqual(self.project(), first)

    def test_reachable_patches_and_package_profiles_are_retained(self):
        self.workspace["patch"] = {"crates-io": {
            "serde": {"git": "https://example.invalid/serde", "rev": "a" * 40},
            "unused": {"git": "https://example.invalid/unused", "rev": "b" * 40},
        }}
        self.workspace["profile"] = {"release": {
            "panic": "abort",
            "package": {"serde": {"opt-level": 3}, "unused": {"opt-level": 1}},
        }}
        baseline = self.project()
        self.assertEqual(set(baseline["patch"]["crates-io"]), {"serde"})
        self.assertEqual(set(baseline["profile"]["release"]["package"]), {"serde"})
        self.workspace["patch"]["crates-io"]["unused"]["rev"] = "c" * 40
        self.workspace["profile"]["release"]["package"]["unused"]["opt-level"] = 2
        self.assertEqual(self.project(), baseline)
        self.workspace["patch"]["crates-io"]["serde"]["rev"] = "d" * 40
        self.assertNotEqual(self.project(), baseline)
        self.workspace["patch"]["crates-io"]["serde"]["rev"] = "a" * 40
        self.workspace["profile"]["release"]["package"]["*"] = {"opt-level": 2}
        self.assertNotEqual(self.project(), baseline)

    def test_explicit_and_nested_workspace_roots_fail_closed(self):
        package = self.manifests["crates/lib/Cargo.toml"]["package"]
        package["workspace"] = "../other-workspace"
        with self.assertRaisesRegex(projection.ProjectionError, "outside the reviewed root"):
            self.project()
        package["workspace"] = "../.."
        self.project()
        self.manifests["crates/lib/Cargo.toml"]["workspace"] = {}
        with self.assertRaisesRegex(projection.ProjectionError, "nested workspace"):
            self.project()
        del self.manifests["crates/lib/Cargo.toml"]["workspace"]
        self.manifests["crates/Cargo.toml"] = {"workspace": {}}
        with self.assertRaisesRegex(projection.ProjectionError, "nested workspace manifest"):
            self.project()
        del self.manifests["crates/Cargo.toml"]
        with self.assertRaisesRegex(projection.ProjectionError, "missing ancestor manifest evidence"):
            self.project()

    def test_custom_or_malformed_build_script_paths_fail_closed(self):
        package = self.manifests["crates/lib/Cargo.toml"]["package"]
        for value in (False, "build.rs"):
            package["build"] = value
            self.project()
        for value in ("other.rs", "./build.rs", "../other/build.rs", True, 1, {}, []):
            package["build"] = value
            with self.subTest(value=value), self.assertRaisesRegex(projection.ProjectionError, "package.build"):
                self.project()

    def test_legacy_dependency_tables_are_included(self):
        package = self.manifests["crates/lib/Cargo.toml"]
        package["dev_dependencies"] = package.pop("dependencies")
        baseline = self.project()
        self.workspace["workspace"]["dependencies"]["serde"]["features"].append("rc")
        self.assertNotEqual(self.project(), baseline)
        package["target"] = {"cfg(unix)": {"build_dependencies": {"serde": {"workspace": True}}}}
        self.assertIn("serde", self.project()["workspace"]["dependencies"])
        package["dev-dependencies"] = {}
        with self.assertRaisesRegex(projection.ProjectionError, "duplicate dependency table"):
            self.project()

    def test_missing_duplicate_and_mismatched_closure_manifests_fail(self):
        self.manifests["crates/lib/Cargo.toml"] = None
        with self.assertRaisesRegex(projection.ProjectionError, "manifest set"):
            self.project()
        self.workspace, self.manifests, self.graph = fixture()
        self.manifests["crates/future/Cargo.toml"] = copy.deepcopy(self.manifests["crates/lib/Cargo.toml"])
        with self.assertRaisesRegex(projection.ProjectionError, "ambiguous"):
            self.project()
        self.workspace, self.manifests, self.graph = fixture()
        self.manifests["crates/lib/Cargo.toml"]["package"]["version"] = "0.2.0"
        with self.assertRaisesRegex(projection.ProjectionError, "mismatched"):
            self.project()

    def test_same_name_path_substitution_and_escape_fail(self):
        self.workspace["workspace"]["dependencies"]["local-alias"]["path"] = "crates/other"
        with self.assertRaisesRegex(projection.ProjectionError, "mismatched path"):
            self.project()
        self.workspace["workspace"]["dependencies"]["local-alias"]["path"] = "../../outside"
        with self.assertRaisesRegex(projection.ProjectionError, "escapes"):
            self.project()

    def test_direct_local_path_and_patch_are_resolved_not_guessed(self):
        root = self.manifests["crates/root/Cargo.toml"]
        root["dependencies"]["local-alias"] = {"package": "local-lib", "path": "../lib"}
        self.project()
        root["dependencies"]["local-alias"] = {"package": "local-lib", "version": "0.1"}
        with self.assertRaisesRegex(projection.ProjectionError, "unresolved local patch"):
            self.project()
        self.workspace["patch"] = {"crates-io": {"renamed": {"package": "local-lib", "path": "crates/lib"}}}
        self.project()
        self.workspace["patch"]["crates-io"]["renamed"]["path"] = "crates/other"
        with self.assertRaisesRegex(projection.ProjectionError, "unresolved local patch"):
            self.project()

    def test_inherited_overrides_and_unsupported_patch_sources_fail_closed(self):
        root = self.manifests["crates/root/Cargo.toml"]
        root["dependencies"]["local-alias"]["path"] = "../other"
        with self.assertRaisesRegex(projection.ProjectionError, "unsupported inherited dependency override"):
            self.project()
        root["dependencies"]["local-alias"] = {"package": "local-lib", "version": "0.1"}
        self.workspace["patch"] = {"other-registry": {"local-lib": {"path": "crates/lib"}}}
        with self.assertRaisesRegex(projection.ProjectionError, "unresolved local patch"):
            self.project()
        self.workspace["patch"] = {"crates-io": {"local-lib": {"path": "crates/lib"}}}
        root["dependencies"]["local-alias"]["git"] = "https://example.invalid/repo"
        with self.assertRaisesRegex(projection.ProjectionError, "unresolved local patch"):
            self.project()
        del root["dependencies"]["local-alias"]["git"]
        del self.workspace["patch"]
        self.workspace["replace"] = {"local-lib:0.1.0": {"path": "crates/lib"}}
        with self.assertRaisesRegex(projection.ProjectionError, "unresolved local patch"):
            self.project()

    def test_local_lock_edges_and_manifest_declarations_must_agree(self):
        root = self.manifests["crates/root/Cargo.toml"]
        root["dependencies"] = {}
        with self.assertRaisesRegex(projection.ProjectionError, "disagree with lock graph"):
            self.project()

    def test_unsupported_member_and_profile_selectors_fail_closed(self):
        self.workspace["workspace"]["members"].append("crates/*")
        with self.assertRaisesRegex(projection.ProjectionError, "unsupported member"):
            self.project()
        self.workspace["workspace"]["members"].pop()
        self.workspace["profile"] = {"dev": {"package": {"https://example.invalid/#x@1": {"opt-level": 3}}}}
        with self.assertRaisesRegex(projection.ProjectionError, "unsupported Cargo package"):
            self.project()

    def test_duplicate_json_and_symlink_blob_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            index = root / "index.json"
            index.write_text('{"crates/a/Cargo.toml":null,"crates/a/Cargo.toml":null}')
            with self.assertRaisesRegex(projection.ProjectionError, "duplicate"):
                projection.read_manifest_set(index)
            blob = root / "blob"
            blob.write_text('[package]\nname="a"\nversion="0.1.0"\n')
            link = root / "link"
            link.symlink_to(blob)
            index.write_text('{"crates/a/Cargo.toml":' + __import__("json").dumps(str(link)) + '}')
            with self.assertRaisesRegex(projection.ProjectionError, "regular file"):
                projection.read_manifest_set(index)

    def test_real_gateway_local_closure_is_covered(self):
        graph = projection.lock_projection.read_lock(ROOT / "Cargo.lock")
        names = {entry[0].name for entry in graph.projection("opensesame-gateway") if not entry[0].source}
        manifests = {}
        for path in (ROOT / "crates").glob("*/Cargo.toml"):
            document = projection.workspace_projection.read_toml(path)
            if document.get("package", {}).get("name") in names:
                manifests[str(path.relative_to(ROOT))] = document
        self.assertEqual(len(manifests), len(names))
        manifests["crates/Cargo.toml"] = None
        value = projection.project(projection.workspace_projection.read_toml(ROOT / "Cargo.toml"),
                                   manifests, graph, "opensesame-gateway", "crates/gateway/Cargo.toml")
        self.assertIn("sqlx", value["workspace"]["dependencies"])
        self.assertIn("serde", value["workspace"]["dependencies"])
        self.assertGreaterEqual(len(manifests), 2)


if __name__ == "__main__":
    unittest.main()
