"""Regression tests for the read-only Cargo.lock graph projection."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest

SCRIPT = Path(__file__).with_name("cargo-lock-projection.py")
SPEC = importlib.util.spec_from_file_location("cargo_lock_projection", SCRIPT)
projection = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = projection
exec(compile(SCRIPT.read_bytes(), str(SCRIPT), "exec", dont_inherit=True), projection.__dict__)

REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
OTHER_REGISTRY = "registry+https://example.test/index"
GIT = "git+https://example.test/repo?rev=123#123"
ROOT = "opensesame-spiffe-source"
A = "a" * 64
B = "b" * 64


def package(name, version="1.0.0", dependencies=(), source=REGISTRY, checksum=A):
    result = {"name": name, "version": version, "dependencies": list(dependencies)}
    if source is not None:
        result["source"] = source
    if checksum is not None:
        result["checksum"] = checksum
    return result


def fixture():
    return {"version": 4, "package": [
        package(ROOT, "0.1.0", ["spiffe", "other"], None, None),
        package("spiffe", "0.19.0", ["alpha", "beta"]),
        package("alpha"),
        package("beta", dependencies=["leaf"]),
        package("leaf"),
        package("other", dependencies=["orphan"]),
        package("orphan"),
    ]}


def get(doc, name, version=None, source=None):
    matches = [p for p in doc["package"] if p["name"] == name
               and (version is None or p["version"] == version)
               and (source is None or p.get("source") == source)]
    if len(matches) != 1:
        raise AssertionError(f"fixture package {name!r} not unique")
    return matches[0]


def graph(doc, dependency="spiffe"):
    return projection.LockGraph(doc).projection(ROOT, dependency)


def render(doc, reverse=False):
    lines = ["# generated test input", f'version = {doc["version"]}', ""]
    packages = list(reversed(doc["package"])) if reverse else doc["package"]
    for item in packages:
        lines.append("[[package]]")
        keys = list(reversed(list(item))) if reverse else item
        for key in keys:
            value = item[key]
            if reverse and key == "dependencies":
                value = list(reversed(value))
            lines.append(f"{key} = {json.dumps(value)}")
        lines.append("")
    return "\n".join(lines)


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.original = fixture()
        self.updated = copy.deepcopy(self.original)

    def test_direct_version_change(self):
        get(self.updated, "spiffe")["version"] = "0.20.0"
        self.assertNotEqual(graph(self.original), graph(self.updated))

    def test_direct_checksum_change(self):
        get(self.updated, "spiffe")["checksum"] = B
        self.assertNotEqual(graph(self.original), graph(self.updated))

    def test_direct_source_change(self):
        get(self.updated, "spiffe")["source"] = OTHER_REGISTRY
        self.assertNotEqual(graph(self.original), graph(self.updated))

    def test_reachable_transitive_version_and_checksum_changes(self):
        get(self.updated, "leaf")["version"] = "1.0.1"
        self.assertNotEqual(graph(self.original), graph(self.updated))
        self.updated = copy.deepcopy(self.original)
        get(self.updated, "leaf")["checksum"] = B
        self.assertNotEqual(graph(self.original), graph(self.updated))

    def test_edge_change_matters_even_if_reachable_nodes_are_unchanged(self):
        get(self.updated, "alpha")["dependencies"].append("beta")
        old = graph(self.original)
        new = graph(self.updated)
        self.assertEqual({item[0] for item in old}, {item[0] for item in new})
        self.assertNotEqual(old, new)

    def test_unrelated_change_is_ignored_for_selected_dependency(self):
        get(self.updated, "other")["version"] = "2.0.0"
        get(self.updated, "orphan")["checksum"] = B
        self.assertEqual(graph(self.original), graph(self.updated))
        self.assertNotEqual(graph(self.original, None), graph(self.updated, None))

    def test_root_version_does_not_change_named_dependency_closure(self):
        get(self.updated, ROOT)["version"] = "0.2.0"
        self.assertEqual(graph(self.original), graph(self.updated))
        self.assertNotEqual(graph(self.original, None), graph(self.updated, None))

    def test_package_and_dependency_order_are_irrelevant(self):
        self.updated["package"].reverse()
        for item in self.updated["package"]:
            item["dependencies"].reverse()
        self.assertEqual(graph(self.original), graph(self.updated))

    def test_equivalent_explicit_qualifiers_do_not_change_edges(self):
        get(self.updated, ROOT)["dependencies"][0] = f"spiffe 0.19.0 ({REGISTRY})"
        get(self.updated, "spiffe")["dependencies"][0] = "alpha 1.0.0"
        self.assertEqual(graph(self.original), graph(self.updated))

    def test_self_dependency_cycle_is_finite_and_preserved(self):
        get(self.original, ROOT)["dependencies"].append(ROOT)
        old = graph(self.original, None)
        self.assertEqual(len(old), len(self.original["package"]))
        root_node = next(item for item in old if item[0].name == ROOT)
        self.assertIn(root_node[0], root_node[2])

    def test_version_qualifier_resolves_duplicate_names(self):
        get(self.original, "spiffe")["dependencies"].append("duplicate 1.0.0")
        self.original["package"].extend([package("duplicate"), package("duplicate", "2.0.0")])
        changed = copy.deepcopy(self.original)
        get(changed, "duplicate", "2.0.0")["checksum"] = B
        self.assertEqual(graph(self.original), graph(changed))
        get(changed, "duplicate", "1.0.0")["checksum"] = B
        self.assertNotEqual(graph(self.original), graph(changed))

    def test_source_qualifier_resolves_same_name_and_version(self):
        get(self.original, "spiffe")["dependencies"].append(f"duplicate 1.0.0 ({GIT})")
        self.original["package"].extend([
            package("duplicate"), package("duplicate", source=GIT, checksum=None),
        ])
        changed = copy.deepcopy(self.original)
        get(changed, "duplicate", source=REGISTRY)["checksum"] = B
        self.assertEqual(graph(self.original), graph(changed))
        get(changed, "duplicate", source=GIT)["source"] = GIT + "new"
        get(changed, "spiffe")["dependencies"][-1] = f"duplicate 1.0.0 ({GIT}new)"
        self.assertNotEqual(graph(self.original), graph(changed))

    def test_name_or_version_only_ambiguity_is_rejected(self):
        get(self.original, "spiffe")["dependencies"].append("duplicate")
        self.original["package"].extend([package("duplicate"), package("duplicate", "2.0.0")])
        with self.assertRaises(projection.LockError):
            graph(self.original)
        get(self.original, "spiffe")["dependencies"][-1] = "duplicate 1.0.0"
        self.original["package"].append(package("duplicate", source=GIT, checksum=None))
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_unrelated_ambiguous_reference_is_also_rejected(self):
        self.original["package"].append(package("orphan", "2.0.0"))
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_duplicate_package_identity_is_rejected(self):
        self.original["package"].append(package("spiffe", "0.19.0", checksum=B))
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_root_must_be_unique_and_workspace_local(self):
        self.original["package"] = [p for p in self.original["package"] if p["name"] != ROOT]
        with self.assertRaises(projection.LockError):
            graph(self.original)
        self.original["package"].extend([
            package(ROOT, "0.1.0", source=None, checksum=None),
            package(ROOT, "0.2.0", source=None, checksum=None),
        ])
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_source_less_root_is_selected_over_registry_name_collision(self):
        self.updated["package"].append(package(ROOT, "0.1.0"))
        self.assertEqual(graph(self.original), graph(self.updated))
        self.assertEqual(graph(self.original, None), graph(self.updated, None))

    def test_selected_direct_dependency_must_exist_and_be_unique(self):
        with self.assertRaises(projection.LockError):
            graph(self.original, "missing")
        self.original["package"].append(package("spiffe", "0.20.0"))
        get(self.original, ROOT)["dependencies"] = ["spiffe 0.19.0", "spiffe 0.20.0", "other"]
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_malformed_references_and_missing_targets_are_rejected(self):
        for ref in ("spiffe 0.19", "spiffe (registry+https://example.test)",
                    "spiffe 0.19.0 (bad-source)", "spiffe 0.19.0 trailing", "unknown"):
            with self.subTest(ref=ref):
                doc = fixture()
                get(doc, ROOT)["dependencies"][0] = ref
                with self.assertRaises(projection.LockError):
                    graph(doc)

    def test_duplicate_edge_and_unknown_package_field_are_rejected(self):
        get(self.original, ROOT)["dependencies"].append("spiffe 0.19.0")
        with self.assertRaises(projection.LockError):
            graph(self.original)
        self.original = fixture()
        get(self.original, "spiffe")["replace"] = "other"
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_invalid_package_values_are_rejected(self):
        for key, value in (("name", ""), ("version", "1.02.0"), ("source", "bad"),
                           ("checksum", "not-a-checksum"), ("dependencies", "alpha")):
            with self.subTest(key=key):
                doc = fixture()
                get(doc, "spiffe")[key] = value
                with self.assertRaises(projection.LockError):
                    graph(doc)
        del get(self.original, "spiffe")["checksum"]
        with self.assertRaises(projection.LockError):
            graph(self.original)

    def test_version_three_and_build_metadata_are_accepted(self):
        self.original["version"] = 3
        get(self.original, "leaf")["version"] = "1.0.0-rc.1+build.7"
        self.assertTrue(graph(self.original))

    def test_unrecognized_format_and_legacy_checksums_fail_closed(self):
        for value in ({"version": 5, "package": fixture()["package"]},
                      {**fixture(), "unknown": {}},
                      {**fixture(), "metadata": {"checksum spiffe 0.19.0": A}}):
            with self.subTest(value=list(value)):
                with self.assertRaises(projection.LockError):
                    graph(value)

    def test_unresolved_source_reference_is_not_echoed_in_error(self):
        get(self.original, "spiffe")["dependencies"].append(
            "private 1.0.0 (git+https://sensitive-value@example.test/repo#123)"
        )
        with self.assertRaises(projection.LockError) as caught:
            graph(self.original)
        self.assertNotIn("sensitive-value", str(caught.exception))

    def test_real_project_lock_both_modes(self):
        repo = SCRIPT.parents[2]
        actual = projection.read_lock(repo / "Cargo.lock")
        self.assertGreater(len(actual.projection(ROOT, "spiffe")), 1)
        self.assertGreaterEqual(len(actual.projection(ROOT)), len(actual.projection(ROOT, "spiffe")))

    def test_real_lock_detects_reachable_but_not_unrelated_checksum_change(self):
        repo = SCRIPT.parents[2]
        with (repo / "Cargo.lock").open("rb") as handle:
            original = tomllib.load(handle)
        selected = graph(original)
        selected_ids = {entry[0] for entry in selected}
        updated = copy.deepcopy(original)
        spiffe = get(updated, "spiffe")
        spiffe["checksum"] = ("0" if spiffe["checksum"][0] != "0" else "1") + spiffe["checksum"][1:]
        self.assertNotEqual(selected, graph(updated))

        updated = copy.deepcopy(original)
        unrelated = next(pkg for pkg in updated["package"]
                         if pkg.get("checksum") and projection.PackageId(
                             pkg["name"], pkg["version"], pkg.get("source", "")
                         ) not in selected_ids)
        unrelated["checksum"] = ("0" if unrelated["checksum"][0] != "0" else "1") + unrelated["checksum"][1:]
        self.assertEqual(selected, graph(updated))


class CliTests(unittest.TestCase):
    def run_cli(self, before, after, dependency="spiffe", allow_absent=False):
        with tempfile.TemporaryDirectory(prefix="cargo lock projection ") as directory:
            left, right = Path(directory) / "before.lock", Path(directory) / "after.lock"
            left.write_text(before)
            right.write_text(after)
            args = [sys.executable, str(SCRIPT), "--root", ROOT]
            if dependency is not None:
                args += ["--dependency", dependency]
            if allow_absent:
                args.append("--allow-absent")
            return subprocess.run(args + [str(left), str(right)], text=True, capture_output=True, check=False)

    def test_format_only_cli_is_unchanged(self):
        result = self.run_cli(render(fixture()), render(fixture(), reverse=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"changed": False})
        self.assertEqual(result.stderr, "")

    def test_changed_cli_is_machine_readable(self):
        changed = fixture()
        get(changed, "leaf")["checksum"] = B
        result = self.run_cli(render(fixture()), render(changed))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"changed": True})

    def test_invalid_and_missing_root_fail_without_success_output(self):
        for bad in ("not = [valid", render({"version": 4, "package": [package("other")]})):
            with self.subTest(bad=bad[:15]):
                result = self.run_cli(render(fixture()), bad)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("cargo-lock-projection:", result.stderr)

    def test_ambiguous_reference_fails_without_success_output(self):
        changed = fixture()
        changed["package"].append(package("spiffe", "0.20.0"))
        result = self.run_cli(render(fixture()), render(changed))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("resolved to 2 packages", result.stderr)

    def test_allow_absent_distinguishes_introduction_removal_and_no_change(self):
        present = fixture()
        missing_root = fixture()
        missing_root["package"] = [pkg for pkg in missing_root["package"] if pkg["name"] != ROOT]
        missing_dependency = fixture()
        get(missing_dependency, ROOT)["dependencies"].remove("spiffe")
        for missing in (missing_root, missing_dependency):
            for before, after, changed in ((missing, present, True), (present, missing, True), (missing, missing, False)):
                result = self.run_cli(render(before), render(after), allow_absent=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"changed": changed})

    def test_allow_absent_still_rejects_malformed_and_ambiguous_graphs(self):
        malformed = fixture()
        malformed["package"] = [pkg for pkg in malformed["package"] if pkg["name"] != ROOT]
        get(malformed, "other")["dependencies"] = ["missing"]
        ambiguous = fixture()
        ambiguous["package"].append(package(ROOT, "0.2.0", source=None, checksum=None))
        for document in (malformed, ambiguous):
            result = self.run_cli(render(document), render(fixture()), allow_absent=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
