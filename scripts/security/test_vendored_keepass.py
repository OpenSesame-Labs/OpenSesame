import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location("verify_vendored_keepass", HERE / "verify-vendored-keepass.py")
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class VendoredKeepassTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="opensesame-keepass-vendor-")
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / verification.DIRECTORY, self.root / verification.DIRECTORY)
        shutil.copy2(ROOT / verification.ARCHIVE, self.root / verification.ARCHIVE)
        for manifest in verification.WORKSPACES:
            for name in (manifest, manifest.with_name("Cargo.lock")):
                destination = self.root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, destination)

    def tearDown(self):
        self.temp.cleanup()

    def test_expected_source_passes(self):
        verification.verify(self.root)

    def test_rejects_changed_patch(self):
        for relative in verification.PATCHED_FILES:
            with self.subTest(relative=relative):
                target = self.root / verification.DIRECTORY / relative
                original = target.read_bytes()
                target.write_bytes(original + b"\n")
                with self.assertRaisesRegex(ValueError, "does not match"):
                    verification.verify(self.root)
                target.write_bytes(original)

    def test_rejects_changed_unpatched_source(self):
        (self.root / verification.DIRECTORY / "src/lib.rs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "outside the reviewed facade patch"):
            verification.verify(self.root)

    def test_rejects_changed_formatted_metadata(self):
        metadata = self.root / verification.DIRECTORY / verification.FORMATTED_METADATA
        metadata.write_bytes(metadata.read_bytes().rstrip(b"\n"))
        with self.assertRaisesRegex(ValueError, "outside the reviewed facade patch"):
            verification.verify(self.root)

    def test_rejects_extra_source(self):
        (self.root / verification.DIRECTORY / "extra.rs").write_text("extra")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            verification.verify(self.root)

    def test_rejects_changed_archive(self):
        archive = self.root / verification.ARCHIVE
        archive.write_bytes(archive.read_bytes() + b"x")
        with self.assertRaisesRegex(ValueError, "archive does not match"):
            verification.verify(self.root)

    def test_rejects_changed_lock_identity(self):
        lock = self.root / "tests/fuzz/cargo/Cargo.lock"
        content = lock.read_text()
        marker = 'name = "keepass"\nversion = "0.17.0"'
        self.assertEqual(content.count(marker), 1)
        lock.write_text(content.replace(marker, 'name = "keepass"\nversion = "0.16.0"'))
        with self.assertRaisesRegex(ValueError, "identity is not"):
            verification.verify(self.root)

    def test_rejects_changed_patch_path(self):
        manifest = self.root / "Cargo.toml"
        content = manifest.read_text()
        marker = 'keepass = { path = "patches/vendor/keepass-0.17.0" }'
        self.assertEqual(content.count(marker), 1)
        manifest.write_text(content.replace(marker, 'keepass = { path = "elsewhere" }'))
        with self.assertRaisesRegex(ValueError, "outside the verified source"):
            verification.verify(self.root)


if __name__ == "__main__":
    unittest.main()
