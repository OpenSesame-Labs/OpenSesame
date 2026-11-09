"""Regression tests for source drift and absent unsupported cryptography."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class SourceSubsetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opensesame-crypto-verify-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.subset = self.root / "third_party" / "x-crypto"
        shutil.copytree(ROOT / "third_party" / "x-crypto", self.subset)
        shutil.copyfile(ROOT / "verify-crypto-subset.py", self.root / "verify-crypto-subset.py")
        shutil.copyfile(ROOT / "go.mod", self.root / "go.mod")
        self.manifest = json.loads((self.subset / "UPSTREAM.json").read_text())
        self.source = self.subset / "chacha20" / "chacha_generic.go"

    def write_manifest(self):
        (self.subset / "UPSTREAM.json").write_text(json.dumps(self.manifest))

    def plant_vectors(self, upstream):
        for name in list(self.manifest["test_vector_files"]):
            blob = f"canonical vector {name}\n".encode()
            path = upstream / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
            self.manifest["test_vector_files"][name] = hashlib.sha256(blob).hexdigest()
        self.write_manifest()

    def metadata_for(self, upstream):
        metadata = self.root / "upstream.json"
        metadata.write_text(json.dumps({
            "Path": self.manifest["module"], "Version": self.manifest["version"],
            "Sum": self.manifest["sum"], "Origin": {"Hash": self.manifest["commit"]},
            "Dir": str(upstream),
        }))
        return metadata

    def run_verifier(self, *args):
        return subprocess.run(
            ["python3", str(self.root / "verify-crypto-subset.py"), *args],
            capture_output=True, text=True, timeout=10, check=False,
        )

    def assert_rejected(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("verification failed", result.stderr)

    def test_unchanged_source_passes(self):
        vectors = self.manifest["test_vector_files"]
        self.assertEqual(vectors, {
            "chacha20/vectors_test.go": "792b8a5df7e455eaa371ba649b17ee95693deefdaeb85f324322db91ea58a432",
            "internal/poly1305/vectors_test.go": "636bc6dde09403bb787819a8a0f8b5521d5655bad6c3c17c21907106cbb96e31",
        })
        self.assertIn("chacha20poly1305/chacha20poly1305_vectors_test.go", self.manifest["files"])
        for name in vectors:
            self.assertNotIn(name, self.manifest["files"])
            self.assertFalse((self.subset / name).exists())
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_modified_or_missing_source_fails(self):
        self.source.write_text(self.source.read_text() + "\n// changed\n")
        self.assert_rejected()
        self.source.unlink()
        self.assert_rejected()

    def test_unsupported_package_and_symlink_fail(self):
        unsupported = self.subset / "openpgp"
        unsupported.mkdir()
        (unsupported / "packet.go").write_text("package openpgp\n")
        self.assert_rejected()
        shutil.rmtree(unsupported)
        self.source.unlink()
        self.source.symlink_to(ROOT / "third_party" / "x-crypto" / "chacha20" / "chacha_generic.go")
        self.assert_rejected()

    def test_version_mismatch_fails(self):
        project = self.root / "go.mod"
        project.write_text(project.read_text().replace(self.manifest["version"], "v0.1.0"))
        self.assert_rejected()

    def test_every_included_package_requires_advisory_analysis(self):
        packages = {
            self.manifest["module"] + "/" + str(Path(name).parent)
            for name in self.manifest["files"] if name.endswith(".go")
        }
        imports = self.root / "imports.txt"
        imports.write_text("\n".join(packages))
        self.assertEqual(self.run_verifier("--imports", str(imports)).returncode, 0)
        imports.write_text("\n".join(packages - {"golang.org/x/crypto/cryptobyte/asn1"}))
        result = self.run_verifier("--imports", str(imports))
        self.assertEqual(result.returncode, 1)
        self.assertIn("omitted from advisory analysis", result.stderr)

    def test_rehashing_modified_source_cannot_pass_upstream_comparison(self):
        upstream = self.root / "canonical"
        shutil.copytree(self.subset, upstream)
        self.plant_vectors(upstream)
        self.source.write_text(self.source.read_text() + "\n// changed\n")
        name = self.source.relative_to(self.subset).as_posix()
        self.manifest["files"][name] = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.write_manifest()
        result = self.run_verifier("--upstream-metadata", str(self.metadata_for(upstream)))
        self.assertEqual(result.returncode, 1)
        self.assertIn("differs from canonical upstream", result.stderr)

    def test_pinned_vectors_match_canonical_release(self):
        upstream = self.root / "canonical"
        shutil.copytree(self.subset, upstream)
        self.plant_vectors(upstream)
        overlay = self.root / "overlay.json"
        result = self.run_verifier(
            "--upstream-metadata", str(self.metadata_for(upstream)),
            "--overlay", str(overlay),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        replace = json.loads(overlay.read_text())["Replace"]
        self.assertEqual(len(replace), 2)
        for name in self.manifest["test_vector_files"]:
            virtual = os.path.abspath(self.subset / name)
            self.assertIn(virtual, replace)
            self.assertEqual(Path(replace[virtual]).read_bytes(), (upstream / name).read_bytes())

    def test_canonical_vector_mismatch_does_not_write_overlay(self):
        upstream = self.root / "canonical"
        shutil.copytree(self.subset, upstream)
        self.plant_vectors(upstream)
        vector = upstream / "chacha20" / "vectors_test.go"
        vector.write_bytes(vector.read_bytes() + b"\n// tampered\n")
        overlay = self.root / "overlay.json"
        result = self.run_verifier(
            "--upstream-metadata", str(self.metadata_for(upstream)),
            "--overlay", str(overlay),
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("differs from canonical upstream", result.stderr)
        self.assertFalse(overlay.exists())

    def test_missing_canonical_vector_is_an_omission(self):
        upstream = self.root / "canonical"
        shutil.copytree(self.subset, upstream)
        result = self.run_verifier("--upstream-metadata", str(self.metadata_for(upstream)))
        self.assertEqual(result.returncode, 1)
        self.assertIn("omitted or added", result.stderr)

    def test_vendored_overlay_vector_is_rejected(self):
        (self.subset / "chacha20" / "vectors_test.go").write_text("package chacha20\n")
        self.assert_rejected()

    def test_overlay_set_cannot_grow(self):
        name = "chacha20/xor.go"
        self.manifest["test_vector_files"][name] = self.manifest["files"].pop(name)
        (self.subset / name).unlink()
        self.write_manifest()
        self.assert_rejected()

    def test_overlay_requires_upstream_metadata(self):
        result = self.run_verifier("--overlay", str(self.root / "overlay.json"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("verification failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
