"""Check authority coverage against relevant and unrelated Cargo changes."""
import copy
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("authority_drift_tested", ROOT / "spec/formal/authority/check-drift.py")
checker = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = checker
exec(compile(Path(SPEC.origin).read_bytes(), SPEC.origin, "exec", dont_inherit=True), checker.__dict__)


class AuthorityCargoDriftTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="authority-cargo-drift-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = json.loads((ROOT / "spec/formal/authority/coverage.json").read_text())
        for path in ["Cargo.toml", "Cargo.lock", "spec/formal/authority/coverage.json",
                     *(entry["path"] for entry in self.manifest["sources"])]:
            source = ROOT / path
            destination = self.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        self.old_root = checker.root
        checker.root = self.root
        self.addCleanup(setattr, checker, "root", self.old_root)
        checker.verify(self.manifest)

    def modify(self, path, before, after):
        target = self.root / path
        data = target.read_text()
        self.assertEqual(data.count(before), 1, path)
        target.write_text(data.replace(before, after))

    def test_unrelated_workspace_and_lock_changes_remain_valid(self):
        self.modify("Cargo.toml", 'async-nats = "0.52.0"', 'async-nats = "0.53.0"')
        target = self.root / "Cargo.lock"
        content, count = re.subn(r'(\[\[package\]\]\nname = "async-nats"\nversion = "[^"]+"\nsource = "[^"]+"\nchecksum = ")[a-f0-9]{64}(")',
                                 lambda m: m.group(1) + "f" * 64 + m.group(2), target.read_text(), count=1)
        self.assertEqual(count, 1)
        target.write_text(content)
        checker.verify(self.manifest)

    def test_changed_inherited_workspace_dependency_is_rejected(self):
        self.modify("Cargo.toml", 'serde = { version = "1.0.219", features = ["derive"] }',
                    'serde = { version = "1.0.219", features = ["derive", "rc"] }')
        with self.assertRaisesRegex(ValueError, "workspace inputs drift"):
            checker.verify(self.manifest)

    def test_changed_reachable_lock_dependency_is_rejected(self):
        target = self.root / "Cargo.lock"
        content, count = re.subn(r'(\[\[package\]\]\nname = "serde"\nversion = "[^"]+"\nsource = "[^"]+"\nchecksum = ")[a-f0-9]{64}(")',
                                 lambda m: m.group(1) + "f" * 64 + m.group(2), target.read_text(), count=1)
        self.assertEqual(count, 1)
        target.write_text(content)
        with self.assertRaisesRegex(ValueError, "dependency graph drift"):
            checker.verify(self.manifest)

    def test_domain_and_standalone_harness_inputs_are_hashed(self):
        for path in ("crates/domain/Cargo.toml", "spec/formal/authority/Cargo.toml", "spec/formal/authority/Cargo.lock"):
            with self.subTest(path=path):
                target = self.root / path
                previous = target.read_bytes()
                target.write_bytes(previous + b"\n# changed\n")
                with self.assertRaisesRegex(ValueError, "source drift"):
                    checker.verify(self.manifest)
                target.write_bytes(previous)

    def test_harness_direct_version_and_checksum_must_match_production(self):
        production = checker.projection.lock_projection.read_lock(self.root / "Cargo.lock")
        harness = checker.projection.lock_projection.read_lock(self.root / "spec/formal/authority/Cargo.lock")
        checker.verify_harness_dependencies(production, harness)
        dependency = next(dep for dep in harness.edges[harness.select(checker.root_package)] if dep.name == "serde")
        package = harness.packages[dependency]
        harness.packages[dependency] = checker.projection.lock_projection.Package(
            dependency, "f" * 64, package.references)
        with self.assertRaisesRegex(ValueError, "harness direct dependency differs from production: serde"):
            checker.verify_harness_dependencies(production, harness)

    def test_implicit_build_script_is_reviewed_even_when_initially_absent(self):
        build = self.root / "crates/domain/build.rs"
        build.write_text("fn main() {}\n")
        with self.assertRaisesRegex(ValueError, "source drift in crates/domain/build.rs"):
            checker.verify(self.manifest)
        self.manifest["optional_sources"][0]["sha256"] = sha256(build.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "build script requires separately reviewed"):
            checker.verify(self.manifest)

    def test_custom_manifest_paths_are_rejected_after_a_hash_update(self):
        for section in ("[package]\nbuild = \"src/build.rs\"\n", "[lib]\npath = \"src/other.rs\"\n"):
            with self.subTest(section=section):
                target = self.root / "crates/domain/Cargo.toml"
                previous = target.read_text()
                if section.startswith("[package]"):
                    target.write_text(previous.replace("[package]\n", section, 1))
                else:
                    target.write_text(previous + "\n" + section)
                changed = copy.deepcopy(self.manifest)
                next(item for item in changed["sources"] if item["path"] == "crates/domain/Cargo.toml")["sha256"] = sha256(target.read_bytes()).hexdigest()
                with self.assertRaisesRegex(ValueError, "unsupported domain"):
                    checker.verify(changed)
                target.write_text(previous)

    def test_redirects_and_macro_generated_wiring_fail_after_hash_update(self):
        lib = self.root / "crates/domain/src/lib.rs"
        original = lib.read_text()
        variants = (
            original.replace("pub mod grant;", '#[path = "alternate.rs"]\npub mod grant;', 1),
            original.replace("pub mod grant;", 'include!("alternate.rs");\npub mod grant;', 1),
            original.replace("pub mod task;", "pub mod alternate_ids;\npub mod task;", 1)
                    .replace("pub use ids::*;", "pub use alternate_ids::*;", 1),
        )
        for index, modified in enumerate(variants):
            with self.subTest(index=index):
                lib.write_text(modified)
                changed = copy.deepcopy(self.manifest)
                next(item for item in changed["sources"] if item["path"] == "crates/domain/src/lib.rs")["sha256"] = sha256(lib.read_bytes()).hexdigest()
                with self.assertRaisesRegex(ValueError, "module wiring|crate root syntax"):
                    checker.verify(changed)
        lib.write_text(original)

    def test_unreviewed_build_script_fails_before_lean_or_cargo(self):
        for path in ("spec/formal/authority/check.sh", "scripts/security/cargo-workspace-projection.py",
                     "scripts/security/cargo-lock-projection.py", "spec/formal/authority/check-drift.py",
                     "rust-toolchain.toml"):
            destination = self.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, destination)
        (self.root / "crates/domain/build.rs").write_text("fn main() {}\n")
        tools = self.root / "fake-bin"
        tools.mkdir()
        version = re.search(r'channel\s*=\s*"([^"]+)"', (self.root / "rust-toolchain.toml").read_text()).group(1)
        for name, contents in {
            "lean": '#!/bin/sh\nprintf "Lean (version 4.24.0, test)\\n"\n',
            "rustc": f'#!/bin/sh\nprintf "rustc {version} test\\n"\n',
            "cargo": '#!/bin/sh\nprintf invoked > "$AUTHORITY_CARGO_MARKER"\n',
        }.items():
            path = tools / name
            path.write_text(contents)
            path.chmod(0o755)
        axiom_checker = self.root / "spec/formal/check-axioms.sh"
        axiom_checker.write_text('#!/bin/sh\nprintf invoked > "$AUTHORITY_LEAN_MARKER"\n')
        env = dict(os.environ, OPENSESAME_LEAN_BIN=str(tools / "lean"), RUSTC=str(tools / "rustc"),
                   CARGO_TARGET_DIR=str(self.root / "target"), AUTHORITY_CARGO_MARKER=str(self.root / "cargo-ran"),
                   AUTHORITY_LEAN_MARKER=str(self.root / "lean-ran"), PATH=f'{tools}:{os.environ["PATH"]}')
        result = subprocess.run(["bash", "spec/formal/authority/check.sh"], cwd=self.root,
                                env=env, text=True, capture_output=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source drift in crates/domain/build.rs", result.stderr)
        self.assertFalse((self.root / "cargo-ran").exists())
        self.assertFalse((self.root / "lean-ran").exists())

    def test_invalid_coverage_and_projection_records_fail_closed(self):
        for value in (None, [], {}, {**self.manifest, "sources": [None]},
                      {**self.manifest, "workspace_projection": None},
                      {**self.manifest, "lock_projection": None}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                checker.verify(copy.deepcopy(value))


if __name__ == "__main__":
    unittest.main()
