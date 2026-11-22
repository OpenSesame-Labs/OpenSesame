#!/usr/bin/env python3
"""Exercise the archived seeds through the real local and OSS-Fuzz entry points."""

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/fuzz/capability-corpus.py"
BUNDLE = ROOT / "tests/fuzz/cargo/corpus-bundles/capability_algebra.json"
BASELINE = "84f2215617222372d9c1397f6b3c45eaffd8c34263f28c4f6b30c88d1c504759"


def run(*args, **kwargs):
    environment = dict(kwargs.get("env", os.environ))
    for name in list(environment):
        if name in {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                    "GIT_NAMESPACE", "GIT_TEMPLATE_DIR"} or name.startswith("GIT_CONFIG_"):
            environment.pop(name)
    environment["GIT_CONFIG_GLOBAL"] = os.devnull
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    kwargs["env"] = environment
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


def bundled():
    contents = json.loads(BUNDLE.read_text(encoding="utf-8"))["seeds"]
    return {name: base64.b64decode(data, validate=True) for name, data in contents.items()}


def corpus_digest(seeds):
    digest = hashlib.sha256()
    for name, value in sorted(seeds.items()):
        encoded = name.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
    return digest.hexdigest()


class CapabilityCorpusTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="capability-corpus-test-")
        self.addCleanup(self.temporary.cleanup)
        self.temp = Path(self.temporary.name)

    def helper(self, *args):
        return run("python3", str(HELPER), *(str(arg) for arg in args))

    def test_original_names_and_bytes_and_deterministic_round_trip(self):
        seeds = bundled()
        self.assertEqual(len(seeds), 559)
        self.assertEqual(corpus_digest(seeds), BASELINE)
        materialized = self.temp / "seeds"
        self.assertEqual(self.helper("materialize", BUNDLE, materialized).returncode, 0)
        self.assertEqual({p.name: p.read_bytes() for p in materialized.iterdir()}, seeds)
        packed = self.temp / "packed.json"
        self.assertEqual(self.helper("pack", materialized, packed).returncode, 0)
        self.assertEqual(packed.read_bytes(), BUNDLE.read_bytes())

    def test_refuses_existing_output_and_unsafe_or_malformed_bundle(self):
        destination = self.temp / "existing"
        destination.mkdir()
        (destination / "keep").write_text("developer data")
        self.assertNotEqual(self.helper("materialize", BUNDLE, destination).returncode, 0)
        self.assertEqual((destination / "keep").read_text(), "developer data")
        existing_bundle = self.temp / "existing-bundle.json"
        existing_bundle.write_bytes(BUNDLE.read_bytes())
        self.assertNotEqual(self.helper("pack", destination, existing_bundle).returncode, 0)
        self.assertEqual(existing_bundle.read_bytes(), BUNDLE.read_bytes())
        invalid = [
            '{"version":1,"seeds":{"../escape":"YQ=="}}',
            '{"version":1,"seeds":{"same":"YQ==","same":"Yg=="}}',
            '{"version":1,"seeds":{"seed":"%%"}}',
            '{"version":true,"seeds":{"seed":"YQ=="}}',
            '{"version":1,"seeds":{}}',
        ]
        for index, data in enumerate(invalid):
            with self.subTest(data=data):
                path = self.temp / f"invalid-{index}.json"
                path.write_text(data)
                output = self.temp / f"out-{index}"
                self.assertNotEqual(self.helper("materialize", path, output).returncode, 0)
                self.assertFalse(output.exists())
        oversized = self.temp / "oversized.json"
        with oversized.open("wb") as output:
            output.truncate(2 * 1024 * 1024 + 1)
        self.assertNotEqual(self.helper("materialize", oversized, self.temp / "oversized").returncode, 0)
        linked = self.temp / "linked.json"
        linked.symlink_to(BUNDLE)
        self.assertNotEqual(self.helper("materialize", linked, self.temp / "linked").returncode, 0)
        source = self.temp / "source"
        source.mkdir()
        (source / "seed").symlink_to(destination / "keep")
        self.assertNotEqual(self.helper("pack", source, self.temp / "unsafe.json").returncode, 0)

    def test_zip_is_complete_deterministic_and_refuses_conflicts(self):
        loose = self.temp / "loose"
        loose.mkdir()
        (loose / "reviewed").write_bytes(b"reviewed seed")
        (loose / "nested").mkdir()
        (loose / "nested/reviewed.txt").write_bytes(b"nested seed")
        output = self.temp / "corpus.zip"
        result = self.helper("zip", BUNDLE, loose, output)
        self.assertEqual(result.returncode, 0, result.stderr)
        first = output.read_bytes()
        with zipfile.ZipFile(output) as archive:
            self.assertEqual({name: archive.read(name) for name in archive.namelist()},
                             {**bundled(), "reviewed": b"reviewed seed",
                              "nested/reviewed.txt": b"nested seed"})
        self.assertEqual(self.helper("zip", BUNDLE, loose, output).returncode, 0)
        self.assertEqual(output.read_bytes(), first)
        conflict = loose / next(iter(bundled()))
        conflict.write_bytes(b"conflicting data")
        self.assertNotEqual(self.helper("zip", BUNDLE, loose, output).returncode, 0)
        self.assertEqual(output.read_bytes(), first)
        conflict.unlink()
        (loose / "linked").symlink_to(loose / "nested", target_is_directory=True)
        self.assertNotEqual(self.helper("zip", BUNDLE, loose, output).returncode, 0)
        self.assertEqual(output.read_bytes(), first)

    def test_zip_respects_umask_and_does_not_widen_existing_permissions(self):
        output = self.temp / "corpus.zip"
        command = ("python3", str(HELPER), "zip", str(BUNDLE),
                   str(self.temp / "no-loose-corpus"), str(output))
        self.assertEqual(run(*command, preexec_fn=lambda: os.umask(0o022)).returncode, 0)
        self.assertEqual(output.stat().st_mode & 0o777, 0o644)
        output.chmod(0o600)
        self.assertEqual(run(*command, preexec_fn=lambda: os.umask(0o022)).returncode, 0)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        output.unlink()
        self.assertEqual(run(*command, preexec_fn=lambda: os.umask(0o077)).returncode, 0)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def fixture(self):
        checkout = self.temp / "opensesame"
        for relative in [
            "scripts/fuzz/capability-corpus.py",
            "scripts/fuzz/fuzz-one.sh",
            "scripts/lib/fuzz-directory.sh",
            "scripts/lib/audit-directory.sh",
            "tests/fuzz/clusterfuzzlite/build.sh",
            "tests/fuzz/cargo/corpus-bundles/capability_algebra.json",
        ]:
            destination = checkout / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        seeds = checkout / "tests/fuzz/cargo/corpus/capability_algebra"
        seeds.mkdir(parents=True)
        (seeds / "reviewed").write_bytes(b"reviewed seed")
        (seeds / "nested").mkdir()
        (seeds / "nested/reviewed.txt").write_bytes(b"nested seed")
        regressions = checkout / "tests/fuzz/cargo/regressions/capability_algebra"
        regressions.mkdir(parents=True)
        (regressions / "crash").write_bytes(b"regression")
        self.assertEqual(run("git", "init", "--quiet", str(checkout)).returncode, 0)
        self.assertEqual(run("git", "-C", str(checkout), "add", ".").returncode, 0)
        (seeds / "unreviewed").write_bytes(b"untracked seed")
        return checkout, seeds

    def test_manual_runner_materializes_reviewed_seeds_without_modifying_checkout(self):
        checkout, seeds = self.fixture()
        commands = self.temp / "bin"
        commands.mkdir()
        cargo = commands / "cargo"
        cargo.write_text('''#!/usr/bin/env python3
import base64,json,os,pathlib,sys
args=sys.argv[1:]
corpus=pathlib.Path(args[args.index("--fuzz-dir") + 2])
files={p.relative_to(corpus).as_posix():base64.b64encode(p.read_bytes()).decode()
       for p in corpus.rglob("*") if p.is_file()}
pathlib.Path(os.environ["CAPTURE"]).write_text(json.dumps({"args":args,"files":files}))
''')
        cargo.chmod(0o755)
        capture = self.temp / "capture.json"
        audit = self.temp / "audit"
        audit.mkdir(mode=0o700)
        env = {**os.environ, "PATH": f'{commands}:{os.environ["PATH"]}',
               "CAPTURE": str(capture), "OPENSESAME_AUDIT_DIR": str(audit)}
        result = run("bash", str(checkout / "scripts/fuzz/fuzz-one.sh"), "capability_algebra",
                     "--", "-runs=1", cwd=checkout, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(capture.read_text())
        self.assertEqual(invocation["args"][-1], "-runs=1")
        prefix = "tests/fuzz/cargo/corpus/capability_algebra/"
        expected = {prefix + name: data for name, data in bundled().items()}
        expected[prefix + "reviewed"] = b"reviewed seed"
        expected[prefix + "nested/reviewed.txt"] = b"nested seed"
        expected["tests/fuzz/cargo/regressions/capability_algebra/crash"] = b"regression"
        actual = {name: base64.b64decode(value) for name, value in invocation["files"].items()}
        self.assertEqual(actual, expected)
        self.assertEqual({p.name for p in seeds.iterdir()}, {"nested", "reviewed", "unreviewed"})
        self.assertNotIn(prefix + "unreviewed", actual)
        capture.unlink()
        tracked_bundle = "tests/fuzz/cargo/corpus-bundles/capability_algebra.json"
        self.assertEqual(run("git", "-C", str(checkout), "rm", "--cached", tracked_bundle).returncode, 0)
        result = run("bash", str(checkout / "scripts/fuzz/fuzz-one.sh"), "capability_algebra",
                     cwd=checkout, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bundle is not tracked", result.stderr)
        self.assertFalse(capture.exists())
        self.assertEqual(run("git", "-C", str(checkout), "add", tracked_bundle).returncode, 0)
        shutil.rmtree(seeds)
        result = run("bash", str(checkout / "scripts/fuzz/fuzz-one.sh"), "capability_algebra",
                     cwd=checkout, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        clean = json.loads(capture.read_text())["files"]
        expected.pop(prefix + "reviewed")
        expected.pop(prefix + "nested/reviewed.txt")
        self.assertEqual({name: base64.b64decode(value) for name, value in clean.items()}, expected)
        self.assertFalse(seeds.exists())
        capture.unlink()
        seeds.mkdir(parents=True)
        (seeds / next(iter(bundled()))).write_bytes(b"conflicting seed")
        self.assertEqual(run("git", "-C", str(checkout), "add", str(seeds)).returncode, 0)
        result = run("bash", str(checkout / "scripts/fuzz/fuzz-one.sh"), "capability_algebra",
                     cwd=checkout, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflicts with bundle", result.stderr)
        self.assertFalse(capture.exists())

    def test_clusterfuzz_build_publishes_all_bundled_and_loose_seeds(self):
        checkout, seeds = self.fixture()
        target = checkout / "tests/fuzz/cargo/target/native/release/capability_algebra"
        target.parent.mkdir(parents=True)
        target.write_text("#!/bin/sh\nexit 0\n")
        target.chmod(0o755)
        commands = self.temp / "bin"
        commands.mkdir()
        for name in ("cargo", "cargo-fuzz"):
            program = commands / name
            program.write_text("#!/bin/sh\nexit 0\n")
            program.chmod(0o755)
        output = self.temp / "output"
        env = {**os.environ, "PATH": f'{commands}:{os.environ["PATH"]}',
               "SRC": str(self.temp), "OUT": str(output)}
        script = str(checkout / "tests/fuzz/clusterfuzzlite/build.sh")
        result = run("bash", script, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        path = output / "capability_algebra_seed_corpus.zip"
        with zipfile.ZipFile(path) as archive:
            expected = {**bundled(), "reviewed": b"reviewed seed", "unreviewed": b"untracked seed",
                        "nested/reviewed.txt": b"nested seed"}
            self.assertEqual({name: archive.read(name) for name in archive.namelist()}, expected)
        first = path.read_bytes()
        self.assertEqual(run("bash", script, env=env).returncode, 0)
        self.assertEqual(path.read_bytes(), first)
        self.assertEqual({p.name for p in seeds.iterdir()}, {"nested", "reviewed", "unreviewed"})
        shutil.rmtree(seeds)
        self.assertEqual(run("bash", script, env=env).returncode, 0)
        with zipfile.ZipFile(path) as archive:
            self.assertEqual({name: archive.read(name) for name in archive.namelist()}, bundled())
        self.assertFalse(seeds.exists())


if __name__ == "__main__":
    unittest.main()
