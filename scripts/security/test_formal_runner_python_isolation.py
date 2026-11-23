"""Exercise formal shell runners against shadowed Python standard modules."""

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
_SCRATCH = importlib.util.spec_from_file_location("formal_scratch_checkout", ROOT / "scripts/security/formal_scratch_checkout.py")
scratch = importlib.util.module_from_spec(_SCRATCH)
_SCRATCH.loader.exec_module(scratch)
# Stands in for Cargo. `metadata` is answered by the real Cargo (offline; it
# compiles nothing). The JSON builds that formal-cargo-freshness.py drives get
# one local artifact per requested root package, the compiler-wrapper log
# entry the freshness check requires, and then the canned test output.
CARGO_STUB = """
import json, os, subprocess, sys
REAL, RUSTC = {real!r}, {rustc!r}
args = sys.argv[1:]
if args[:1] == ["metadata"]:
    # Metadata asks rustc for target information; give it the real compiler.
    os.execve(REAL, [REAL, *args, "--offline"], {{**os.environ, "RUSTC": RUSTC}})
mutate = os.environ.get("PROOF_TEST_MUTATE")
if mutate:
    with open(mutate, "a") as handle:
        handle.write("\\n# drift\\n")
if "--message-format=json" in args:
    def values(*flags):
        return [args[i + 1] for i, item in enumerate(args[:-1]) if item in flags]
    manifest = os.path.abspath((values("--manifest-path") or ["Cargo.toml"])[0])
    meta = json.loads(subprocess.check_output([REAL, "metadata", "--offline", "--locked", "--no-deps",
                                               "--format-version", "1", "--manifest-path", manifest],
                                              env={{**os.environ, "RUSTC": RUSTC}}))
    names = values("-p", "--package")
    selected = [p for p in meta["packages"] if p["name"] in names or (not names and p["manifest_path"] == manifest)]
    fresh = args[0] != "build" and "--no-run" not in args
    for package in selected:
        target = package["targets"][0]
        print(json.dumps({{"reason": "compiler-artifact", "package_id": package["id"], "target": target,
                          "profile": {{"test": args[0] == "test"}}, "features": [],
                          "filenames": ["/stub/" + target["name"]], "executable": None, "fresh": fresh}}))
        if not fresh:
            with open(os.environ["OPENSESAME_FORMAL_RUSTC_LOG"], "a") as log:
                log.write(target["name"].replace("-", "_") + "\\n")
    print(json.dumps({{"reason": "build-finished", "success": True}}))
    if not fresh:
        raise SystemExit(0)
sys.stdout.write({output!r})
"""


def real_cargo():
    """The toolchain's own Cargo binary, not a version-manager shim that could resolve to the stub."""
    if shutil.which("rustc") is None:
        raise unittest.SkipTest("the repository Rust toolchain is required for Cargo metadata")
    sysroot = subprocess.check_output(["rustc", "--print", "sysroot"], cwd=ROOT, text=True).strip()
    cargo = Path(sysroot) / "bin/cargo"
    if not cargo.is_file():
        raise unittest.SkipTest("the repository Rust toolchain has no Cargo binary")
    return str(cargo)


SUITES = {
    "authority": ("spec/formal/authority/check.sh", "spec/formal/authority/check-drift.py"),
    "dpop": ("spec/formal/dpop/verify.sh", "spec/formal/dpop/check_drift.py"),
    "spiffe": ("spec/formal/spiffe/verify.sh", "spec/formal/spiffe/check-drift.py"),
    "source-lifetime": ("spec/formal/source-lifetime/verify.sh", "spec/formal/source-lifetime/check-drift.py"),
}


class RunnerIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="formal-python-isolation-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name) / "repo"
        cls.real_cargo = real_cargo()
        cls.real_rustc = str(Path(cls.real_cargo).with_name("rustc"))
        paths = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
                 "scripts/security/cargo-lock-projection.py", "scripts/security/cargo-workspace-projection.py",
                 "scripts/security/formal_coverage_drift.py", "scripts/security/formal-cargo-isolation.py",
                 "scripts/security/formal-cargo-freshness.py", "scripts/security/formal_cargo_packages.py",
                 "spec/formal/dpop/mutate.py"}
        for runner, checker in SUITES.values():
            paths.update((runner, checker))
            paths |= scratch.coverage_files(ROOT, str(Path(checker).with_name("coverage.json")))
        # Cargo metadata needs every workspace member and the path patches.
        members = tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]["members"]
        paths |= scratch.tracked_files(ROOT, *members, "patches/vendor", ".cargo")
        # The vendored-crate verifiers the Cargo suites' drift checks run also
        # check the fuzz workspace's patch bindings.
        paths |= scratch.tracked_files(ROOT, "tests/fuzz/cargo/Cargo.toml", "tests/fuzz/cargo/Cargo.lock")
        scratch.copy_files(ROOT, cls.root, paths)
        scratch.init_checkout(cls.root, ROOT)
        (cls.root / "spec/formal/check-axioms.sh").write_text("#!/bin/sh\nprintf 'vectors\\n'\n")
        cls.install_stubs()

    @classmethod
    def install_stubs(cls):
        bin_dir = cls.root / "bin"
        bin_dir.mkdir()
        version = tomllib.loads((cls.root / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
        names = set()
        for runner, _ in SUITES.values():
            script = (ROOT / runner).read_text()
            names.update(re.findall(r'^\s*([A-Za-z][A-Za-z0-9_:]+)\s*(?:\\|; do)\s*$', script, re.M))
            names.update(re.findall(r'^(?:required|signer|correspondence_test)="([^"]+)"', script, re.M))
            names.update(re.findall(r'test ([A-Za-z][A-Za-z0-9_:]+) \.\.\. ok', script))
        prefixes = ("", "signing_fence::tests::", "generations::source_lifetime::tests::", "source::lease_tests::")
        lines = {f"test {prefix}{name} ... ok" for name in names for prefix in prefixes}
        output = "\n".join(sorted(lines)) + "\ntest result: ok. 1 passed; 0 failed; 0 ignored;\n"
        cargo = f"#!{sys.executable} -I\n" + CARGO_STUB.format(real=cls.real_cargo, rustc=cls.real_rustc, output=output)
        rustc = f'''#!/bin/sh
if [ "${{1:-}}" = "--version" ]; then echo 'rustc {version} (stub)'; exit 0; fi
if [ -n "${{PROOF_TEST_MUTATE:-}}" ]; then printf '\\n# drift\\n' >> "$PROOF_TEST_MUTATE"; fi
if [ -n "${{DPOP_REPLAY_SOURCE:-}}" ] && [ ! -f "$DPOP_REPLAY_SOURCE" ]; then
  echo 'missing mutation source' >&2; exit 1
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift
done
case "$output" in
  */mutant) printf '#!/bin/sh\\necho decision mismatch\\nexit 1\\n' > "$output" ;;
  *) printf '#!/bin/sh\\nexit 0\\n' > "$output" ;;
esac
chmod +x "$output"
'''
        for name, content in {"lean": "#!/bin/sh\necho 'Lean (version 4.24.0, stub)'\n",
                              "rustc": rustc, "cargo": cargo}.items():
            path = bin_dir / name
            path.write_text(content)
            path.chmod(0o755)
        cls.env = {**scratch.scrubbed_env(), "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                   "OPENSESAME_LEAN_BIN": str(bin_dir / "lean"), "RUSTC": str(bin_dir / "rustc"),
                   "OPENSESAME_RUSTC": str(bin_dir / "rustc")}
        for name in ("PROOF_TEST_MUTATE", "OPENSESAME_FORMAL_GIT_ROOT"):
            cls.env.pop(name, None)

    def test_runner_checks_ignore_local_stdlib_shadows_and_detect_drift(self):
        for suite, (runner, checker) in SUITES.items():
            with self.subTest(suite=suite):
                checker_path = self.root / checker
                marker = self.root / f"{suite}-shadow-ran"
                injected = f"open({str(marker)!r}, 'w').write('executed')\nraise SystemExit(0)\n"
                shadows = [checker_path.parent / "hashlib.py"]
                if suite in ("authority", "dpop"):
                    shadows.append(checker_path.parent / "tomllib.py")
                if suite == "dpop":
                    shadows.append(checker_path.parent / "pathlib.py")
                for path in shadows:
                    path.write_text(injected)
                try:
                    probe = subprocess.run(["python3", str(checker_path)], cwd=self.root,
                                           env=self.env, text=True, capture_output=True, check=False)
                    self.assertEqual(probe.returncode, 0, probe.stderr)
                    self.assertTrue(marker.exists(), "control did not execute the shadow module")
                    marker.unlink()
                    args = ["bash", str(self.root / runner)]
                    if suite == "dpop":
                        args.append("--negative-controls")
                    good = subprocess.run(args, cwd=self.root, env=self.env, text=True,
                                          capture_output=True, check=False)
                    self.assertFalse(marker.exists())
                    expected, count = {"authority": ("authority-formal: covered sources", 5),
                                       "dpop": ("dpop-formal: source hashes match", 1),
                                       "spiffe": ("spiffe-formal: reviewed source", 8),
                                       "source-lifetime": ("source-lifetime-formal: reviewed source", 2)}[suite]
                    self.assertEqual(good.returncode, 0, good.stderr)
                    # Direct drift checks plus three per formal-cargo-freshness run.
                    self.assertEqual(good.stdout.count(expected), count)
                    if suite == "dpop":
                        self.assertEqual(good.stdout.count("dpop-formal: detected negative control"), 6)
                        runner_path = self.root / runner
                        original_runner = runner_path.read_text()
                        unsafe = original_runner.replace(
                            'python3 -I "$root/spec/formal/dpop/mutate.py"',
                            'python3 "$root/spec/formal/dpop/mutate.py"',
                        )
                        self.assertNotEqual(unsafe, original_runner)
                        try:
                            runner_path.write_text(unsafe)
                            bad = subprocess.run(args, cwd=self.root, env=self.env, text=True,
                                                 capture_output=True, check=False)
                            self.assertNotEqual(bad.returncode, 0, bad.stdout)
                            self.assertTrue(marker.exists())
                            marker.unlink()
                        finally:
                            runner_path.write_text(original_runner)
                    coverage = json.loads((self.root / Path(checker).with_name("coverage.json")).read_text())
                    source = self.root / coverage["sources"][0]["path"]
                    original = source.read_bytes()
                    try:
                        changed = subprocess.run(args, cwd=self.root,
                                                 env={**self.env, "PROOF_TEST_MUTATE": str(source)},
                                                 text=True, capture_output=True, check=False)
                        self.assertNotEqual(changed.returncode, 0, changed.stdout)
                        self.assertIn("drift", changed.stderr.lower())
                        self.assertFalse(marker.exists())
                    finally:
                        source.write_bytes(original)
                finally:
                    for path in shadows:
                        path.unlink()


if __name__ == "__main__":
    unittest.main()
