"""The reviewed SPIFFE drift gate shares the selector's complete lock graph."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("spiffe_lock_drift", ROOT / "spec/formal/spiffe/check-drift.py")
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
exec(compile(Path(SPEC.origin).read_bytes(), SPEC.origin, "exec", dont_inherit=True), module.__dict__)


class SpiffeLockDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / "Cargo.lock").open("rb") as handle:
            cls.lock = tomllib.load(handle)
        cls.coverage = json.loads((ROOT / "spec/formal/spiffe/coverage.json").read_text())
        cls.sdk_source = (ROOT / "crates/spiffe-source/src/lib.rs").read_text()
        cls.graph = module.projection.LockGraph(cls.lock)
        cls.root = cls.graph.select(module.ROOT_PACKAGE)
        cls.reachable = {entry[0] for entry in cls.graph.projection(module.ROOT_PACKAGE)}

    def verify(self, document, source=None):
        module.verify_lock(self.coverage, module.projection.LockGraph(document),
                           self.sdk_source if source is None else source)

    def test_reviewed_graph_matches(self):
        self.verify(self.lock)

    def test_transitive_only_checksum_change_requires_review(self):
        direct = set(self.graph.edges[self.root])
        candidate = next(identity for identity in self.reachable
                         if identity not in direct and identity != self.root
                         and self.graph.packages[identity].checksum is not None)
        modified = copy.deepcopy(self.lock)
        item = next(pkg for pkg in modified["package"]
                    if (pkg["name"], pkg["version"], pkg.get("source", "")) ==
                    (candidate.name, candidate.version, candidate.source))
        item["checksum"] = ("0" if item["checksum"][0] != "0" else "1") + item["checksum"][1:]
        with self.assertRaisesRegex(ValueError, "dependency graph drift"):
            self.verify(modified)

    def test_unrelated_checksum_change_does_not_require_review(self):
        modified = copy.deepcopy(self.lock)
        item = next(pkg for pkg in modified["package"] if pkg.get("checksum") and
                    module.projection.PackageId(pkg["name"], pkg["version"], pkg.get("source", "")) not in self.reachable)
        item["checksum"] = ("0" if item["checksum"][0] != "0" else "1") + item["checksum"][1:]
        self.verify(modified)

    def test_unrelated_other_spiffe_version_does_not_confuse_root_edge(self):
        modified = copy.deepcopy(self.lock)
        root = next(pkg for pkg in modified["package"] if pkg["name"] == module.ROOT_PACKAGE and "source" not in pkg)
        root["dependencies"] = ["spiffe 0.19.0" if ref == "spiffe" else ref for ref in root["dependencies"]]
        modified["package"].append({"name": "spiffe", "version": "99.0.0",
                                    "source": "registry+https://github.com/rust-lang/crates.io-index",
                                    "checksum": "f" * 64})
        self.verify(modified)

    def test_advertised_sdk_must_match_resolved_edge(self):
        with self.assertRaisesRegex(ValueError, "advertised SPIFFE SDK version"):
            self.verify(self.lock, self.sdk_source.replace('"0.19.0"', '"0.16.1"'))

    def test_missing_or_wrong_fingerprint_fails_closed(self):
        for value in (None, {}, {**self.coverage["lock_projection"], "sha256": "0" * 64}):
            changed = copy.deepcopy(self.coverage)
            changed["lock_projection"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.verify_lock(changed, self.graph, self.sdk_source)


if __name__ == "__main__":
    unittest.main()
