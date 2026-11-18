"""Exercise formal shell runners against shadowed Python standard modules."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
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
        paths = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
                 "scripts/security/cargo-lock-projection.py", "scripts/security/cargo-workspace-projection.py",
                 "spec/formal/dpop/mutate.py"}
        for runner, checker in SUITES.values():
            paths.update((runner, checker))
            coverage = str(Path(checker).with_name("coverage.json"))
            paths.add(coverage)
            data = json.loads((ROOT / coverage).read_text())
            for entry in data["sources"] + data.get("optional_sources", []):
                if (ROOT / entry["path"]).is_file():
                    paths.add(entry["path"])
        for name in paths:
            target = cls.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
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
        cargo = "#!/bin/sh\nif [ -n \"${PROOF_TEST_MUTATE:-}\" ]; then printf '\\n# drift\\n' >> \"$PROOF_TEST_MUTATE\"; fi\n"
        cargo += "cat <<'END_TEST_OUTPUT'\n" + "\n".join(sorted(lines)) + "\ntest result: ok. 1 passed; 0 failed; 0 ignored;\nEND_TEST_OUTPUT\n"
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
        cls.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                   "OPENSESAME_LEAN_BIN": str(bin_dir / "lean"), "RUSTC": str(bin_dir / "rustc"),
                   "OPENSESAME_RUSTC": str(bin_dir / "rustc")}
        cls.env.pop("PROOF_TEST_MUTATE", None)

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
                    self.assertEqual(good.returncode, 0, good.stderr)
                    self.assertFalse(marker.exists())
                    expected = {"authority": "authority-formal: covered sources",
                                "dpop": "dpop-formal: source hashes match",
                                "spiffe": "spiffe-formal: reviewed source",
                                "source-lifetime": "source-lifetime-formal: reviewed sources"}[suite]
                    self.assertEqual(good.stdout.count(expected), 1 if suite == "dpop" else 2)
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
