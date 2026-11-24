#!/usr/bin/env python3
"""Reject broken source-lifetime implementations and malformed Lean vectors."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
# The --reviewed-patch declarations of verify.sh's freshness init.
REVIEWED_PATCHES = ("sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0",)
TEST = "lean_vectors_match_source_owned_generation_manager"
SIGNER_TEST = "signing_fence::tests::lean_vectors_match_generation_bound_signer"
ISOLATION: dict = {}
TREES = (Path("crates/domain"), Path("crates/transport-security"), Path("spec/formal/source-lifetime"))
FILES = (Path("Cargo.toml"), Path("Cargo.lock"), Path("rust-toolchain.toml"),
         Path("spec/formal/check-axioms.sh"), Path("spec/formal/required-theorem-command.lean"),
         Path("scripts/security/formal-cargo-isolation.py"), Path("scripts/security/formal-cargo-freshness.py"),
         Path("scripts/security/formal_cargo_packages.py"))


def run(command: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    raw = env.get("OPENSESAME_FORMAL_SCRATCH_LOCK_FD")
    fds = () if raw is None else (int(raw),)
    return subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=300,
                          check=False, pass_fds=fds)


def archive(destination: Path, fds: tuple[int, ...] = ()) -> None:
    proc = subprocess.Popen(["git", "archive", "--format=tar", "HEAD"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=fds)
    assert proc.stdout is not None and proc.stderr is not None
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as source:
            source.extractall(destination, filter="data")
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        proc.stdout.close()
    error = proc.stderr.read().decode("utf-8", errors="replace")
    if proc.wait() != 0:
        raise RuntimeError(f"git archive failed: {error}")
    for relative in TREES:
        source = ROOT / relative
        if any(path.is_symlink() for path in source.rglob("*")):
            raise RuntimeError(f"unexpected symlink in {relative}")
        target = destination / relative
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for relative in FILES:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)


def test(cwd: Path, vector: Path, env: dict[str, str], label: str, diagnostic: str | None) -> None:
    test_env = env | {"OPENSESAME_SOURCE_LIFETIME_VECTORS": str(vector)}
    command = ["cargo", "test", "--locked", "-p", "opensesame-transport-security", "--all-features",
               "--test", "source_lifetime_formal", TEST, "--", "--ignored", "--exact"]
    result = ISOLATION["checked_cargo"](
        cwd, test_env, ["opensesame-transport-security"],
        Path("spec/formal/source-lifetime/check-drift.py"), command[1:],
        reviewed_patches=REVIEWED_PATCHES,
    )
    output = result.stdout + result.stderr
    if diagnostic is None:
        good = result.returncode == 0 and f"test {TEST} ... ok" in output
    else:
        good = (result.returncode == 101 and f"test {TEST} ... FAILED" in output
                and "panicked at" in output and diagnostic in output)
    if not good:
        raise RuntimeError(f"{label}: unexpected result {result.returncode}\n{output[-8000:]}")
    print(f"{label}: {'passed' if diagnostic is None else 'rejected'}", flush=True)


def signer_test(cwd: Path, vector: Path, env: dict[str, str], label: str,
                diagnostic: str | None) -> None:
    test_env = env | {"OPENSESAME_SOURCE_LIFETIME_VECTORS": str(vector)}
    command = ["cargo", "test", "--locked", "-p", "opensesame-transport-security", "--all-features",
               "--lib", SIGNER_TEST, "--", "--ignored", "--exact"]
    result = ISOLATION["checked_cargo"](
        cwd, test_env, ["opensesame-transport-security"],
        Path("spec/formal/source-lifetime/check-drift.py"), command[1:],
        reviewed_patches=REVIEWED_PATCHES,
    )
    output = result.stdout + result.stderr
    if diagnostic is None:
        good = result.returncode == 0 and f"test {SIGNER_TEST} ... ok" in output
    else:
        good = (result.returncode == 101 and f"test {SIGNER_TEST} ... FAILED" in output
                and "panicked at" in output and diagnostic in output)
    if not good:
        raise RuntimeError(f"{label}: unexpected result {result.returncode}\n{output[-8000:]}")
    print(f"{label}: {'passed' if diagnostic is None else 'rejected'}", flush=True)


def main() -> None:
    env = os.environ.copy() | {"CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"}
    env.pop("OPENSESAME_FORMAL_SCRATCH_LOCK_FD", None)
    lean = env.get("OPENSESAME_LEAN_BIN", "lean")
    if shutil.which("cargo") is None or shutil.which(lean) is None:
        raise RuntimeError("activate the pinned Rust and Lean toolchains first")
    baseline = run([sys.executable, "-I", "spec/formal/source-lifetime/check-drift.py"], ROOT, env)
    if baseline.returncode:
        raise RuntimeError(f"live baseline drift: {baseline.stderr}")
    live_helper = ROOT / "scripts/security/formal-cargo-isolation.py"
    lifecycle = {"__name__": "formal_cargo_isolation", "__file__": str(live_helper)}
    exec(compile(live_helper.read_bytes(), str(live_helper), "exec", dont_inherit=True), lifecycle)
    target = ROOT / "crates/transport-security/src/source_lifetime.rs"
    live_hash = hashlib.sha256(target.read_bytes()).hexdigest()
    live_signer = ROOT / "crates/transport-security/src/signing_fence.rs"
    live_signer_hash = hashlib.sha256(live_signer.read_bytes()).hexdigest()
    try:
        with lifecycle["scratch_checkout"](ROOT) as lease:
            scratch = lease.path
            env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(lease.lock_fd)
            # The archive has no .git: resolve reviewed lineage in this checkout.
            env["OPENSESAME_FORMAL_GIT_ROOT"] = str(ROOT)
            archive(scratch, (lease.lock_fd,))
            baseline = run([sys.executable, "-I", "spec/formal/source-lifetime/check-drift.py"], scratch, env)
            if baseline.returncode:
                raise RuntimeError(f"scratch baseline drift: {baseline.stderr}")
            wrapper = subprocess.check_output(
                [sys.executable, "-I", str(scratch / "scripts/security/formal-cargo-isolation.py"), str(scratch)],
                text=True, pass_fds=(lease.lock_fd,),
            ).strip()
            env |= {"RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": wrapper}
            helper = scratch / "scripts/security/formal-cargo-isolation.py"
            ISOLATION.update({"__name__": "formal_cargo_isolation", "__file__": str(helper)})
            exec(compile(helper.read_bytes(), str(helper), "exec", dont_inherit=True), ISOLATION)
            result = run(["bash", "spec/formal/check-axioms.sh", lean,
                          str(scratch / "spec/formal/source-lifetime/SourceLifetime.lean")], scratch, env)
            if result.returncode != 0:
                raise RuntimeError(f"cannot generate Lean vectors: {result.stderr}")
            lines = result.stdout.splitlines()
            if len(lines) != 33:
                raise RuntimeError("unexpected baseline vector count")
            vectors = scratch / "vectors.tsv"
            def write(values: list[str]) -> None:
                vectors.write_text("\n".join(values) + ("\n" if values else ""))
            write(lines)
            test(scratch, vectors, env, "unmodified correspondence", None)
            signer_test(scratch, vectors, env, "unmodified signer correspondence", None)
            bad = []
            bad.append(("empty vectors", [], "incomplete Lean vector matrix"))
            bad.append(("missing vector", lines[:-1], "incomplete Lean vector matrix"))
            duplicate = lines.copy()
            row = duplicate[1].split("\t")
            row[3] = "1" if row[3] == "0" else "0"
            duplicate[2] = "\t".join(row)
            bad.append(("duplicate input with different output", duplicate, "duplicate input"))
            leading_zero = lines.copy()
            row = leading_zero[1].split("\t")
            row[2] = "0" + row[2]
            leading_zero[2] = "\t".join(row)
            bad.append(("noncanonical duplicate input", leading_zero, "noncanonical vector integer"))
            malformed = lines.copy()
            row = malformed[-1].split("\t")
            row[1] = "bogus"
            malformed[-1] = "\t".join(row)
            bad.append(("malformed input bit", malformed, "invalid vector bit"))
            altered = lines.copy()
            row = altered[0].split("\t")
            row[1] = "0" if row[1] == "1" else "1"
            altered[0] = "\t".join(row)
            bad.append(("altered expected output", altered, "assertion `left == right` failed"))
            for label, rows, diagnostic in bad:
                write(rows)
                test(scratch, vectors, env, label, diagnostic)
            altered_signer = lines.copy()
            row = altered_signer[-1].split("\t")
            row[-1] = "1" if row[-1] == "0" else "0"
            altered_signer[-1] = "\t".join(row)
            write(altered_signer)
            signer_test(scratch, vectors, env, "altered signer output", "assertion `left == right` failed")
            write(lines)
            source = scratch / "crates/transport-security/src/source_lifetime.rs"
            original = source.read_text()
            for label, before, after in [
                ("stale epoch allowed", "fence.owner.same(owner) && fence.epoch == epoch", "fence.owner.same(owner) && true"),
                ("identity replacement allowed", "|| !same_identity || !trust_unchanged", "|| false || !trust_unchanged"),
                ("source trust replacement allowed", "|| !same_identity || !trust_unchanged", "|| !same_identity || false"),
                ("deadline equality allowed", "now >= deadline || fence.monotonic_deadline", "now > deadline || fence.monotonic_deadline"),
            ]:
                if original.count(before) != 1:
                    raise RuntimeError(f"{label}: mutation target is not unique")
                with ISOLATION["mutated_coverage"](
                    scratch, Path("spec/formal/source-lifetime/coverage.json"),
                    Path("crates/transport-security/src/source_lifetime.rs"), before, after,
                    Path("spec/formal/source-lifetime/check-drift.py"),
                    env=env,
                ):
                    test(scratch, vectors, env, label, "assertion `left == right` failed")
            test(scratch, vectors, env, "restored correspondence", None)
            signer = scratch / "crates/transport-security/src/signing_fence.rs"
            original_signer = signer.read_text()
            for label, before, after in [
                ("signer pre-check removed",
                 "self.fence.check()?;\n        let signature = self.inner.sign(message)?;",
                 "let signature = self.inner.sign(message)?;"),
                ("signer post-check removed",
                 "let signature = self.inner.sign(message)?;\n        self.fence.check()?;",
                 "let signature = self.inner.sign(message)?;"),
            ]:
                if original_signer.count(before) != 1:
                    raise RuntimeError(f"{label}: mutation target is not unique")
                with ISOLATION["mutated_coverage"](
                    scratch, Path("spec/formal/source-lifetime/coverage.json"),
                    Path("crates/transport-security/src/signing_fence.rs"), before, after,
                    Path("spec/formal/source-lifetime/check-drift.py"),
                    env=env,
                ):
                    signer_test(scratch, vectors, env, label, "assertion `left == right` failed")
            signer_test(scratch, vectors, env, "restored signer correspondence", None)
    finally:
        if hashlib.sha256(target.read_bytes()).hexdigest() != live_hash:
            raise RuntimeError("live source changed while negative controls ran")
        if hashlib.sha256(live_signer.read_bytes()).hexdigest() != live_signer_hash:
            raise RuntimeError("live signing fence changed while negative controls ran")
    print("seven malformed matrices and six implementation mutants rejected", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"source-lifetime-negative-controls: {error}", file=sys.stderr)
        sys.exit(1)
