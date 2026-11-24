#!/usr/bin/env python3
"""Run guarded mutants in a leased scratch checkout and restore it."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parents[3]
model = root / "spec/formal/authority"
mutations = [
    ("export", "crates/domain/src/grant_attenuation.rs",
     'if child.constraints.raw_credential_export && !parent.constraints.raw_credential_export {',
     'if false && child.constraints.raw_credential_export && !parent.constraints.raw_credential_export {'),
    ("replacement", "crates/domain/src/grant.rs",
     'if replacement.constraints.raw_credential_export\n            && !current.constraints.raw_credential_export',
     'if false && replacement.constraints.raw_credential_export\n            && !current.constraints.raw_credential_export'),
    ("issuer", "crates/domain/src/grant_lineage.rs",
     'if !holder_delegates && !issuer_reissues {',
     'if false && !holder_delegates && !issuer_reissues {'),
    ("scope", "crates/domain/src/grant_lineage.rs",
     '(Some(_), None) => false,', '(Some(_), None) => true,'),
    ("drop-key", "crates/domain/src/grant_lineage.rs",
     '(Some(_), None) => Err(DomainError::GrantAttenuation(\n            "proof-of-possession binding dropped by the child".into(),\n        )),',
     '(Some(_), None) => Ok(()),'),
    ("transfer-key", "crates/domain/src/grant_lineage.rs",
     'if parent_key == child_key\n                && child.beneficiary_principal_id != parent.beneficiary_principal_id',
     'if false && parent_key == child_key\n                && child.beneficiary_principal_id != parent.beneficiary_principal_id'),
    ("actions", "crates/domain/src/grant.rs",
     'if !is_subset(&child.actions, &parent.actions) {',
     'if false && !is_subset(&child.actions, &parent.actions) {'),
    ("window", "crates/domain/src/grant_attenuation.rs",
     'if child.expires_at > parent.expires_at {', 'if false && child.expires_at > parent.expires_at {'),
    ("not-before", "crates/domain/src/grant_attenuation.rs",
     '(Some(p), Some(c)) if c < p => {', '(Some(p), Some(c)) if false && c < p => {'),
    ("assurance", "crates/domain/src/grant_attenuation.rs", 'if cr < pr {', 'if false && cr < pr {'),
    ("auth-age", "crates/domain/src/grant_attenuation.rs",
     'Some(child_max) if child_max > parent_max =>', 'Some(child_max) if false && child_max > parent_max =>'),
    ("networks", "crates/domain/src/grant_attenuation.rs",
     'if child.allowed_networks.is_empty() {', 'if false && child.allowed_networks.is_empty() {'),
    ("digest", "crates/domain/src/grant_attenuation.rs",
     'Some(child_digest) if child_digest != parent_digest =>',
     'Some(child_digest) if false && child_digest != parent_digest =>'),
    ("offline", "crates/domain/src/grant_attenuation.rs",
     'if offline_rank(&child.offline_use) > offline_rank(&parent.offline_use) {',
     'if false && offline_rank(&child.offline_use) > offline_rank(&parent.offline_use) {'),
    ("budget-ceiling", "crates/domain/src/grant_budgets.rs",
     'Some(value) if *value >= 0 && value <= ceiling => {}', 'Some(value) if *value >= 0 => {}'),
    ("budget-key", "crates/domain/src/grant_budgets.rs",
     'if !parent.contains_key(key) {', 'if false && !parent.contains_key(key) {'),
    ("depth", "crates/domain/src/grant_attenuation.rs",
     'if child.delegation_depth > parent.constraints.maximum_delegation_depth {',
     'if false && child.delegation_depth > parent.constraints.maximum_delegation_depth {'),
    ("audiences", "crates/domain/src/grant.rs",
     'if !is_subset(&child.constraints.audiences, &parent.constraints.audiences) {',
     'if false && !is_subset(&child.constraints.audiences, &parent.constraints.audiences) {'),
    ("replacement-narrowing", "crates/domain/src/grant.rs",
     'crate::grant_attenuation::validate_constraint_narrowing(\n            &current.constraints,',
     'crate::grant_attenuation::validate_constraint_narrowing(\n            &parent.constraints,'),
    ("selector-boundary", "crates/domain/src/grant_attenuation.rs",
     '|| child_prefix.as_bytes().get(parent_prefix.len()) == Some(&(sep as u8)))',
     '|| true)'),
    ("pattern-length", "crates/domain/src/grant.rs",
     'return resource.len() > prefix.len() && resource.starts_with(prefix);',
     'return resource.starts_with(prefix);'),
]


def scratch_path(base: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise RuntimeError("invalid scratch path")
    relative = Path(name)
    if relative.is_absolute() or str(relative) != name or any(p in (".", "..") for p in relative.parts):
        raise RuntimeError(f"invalid scratch path: {name}")
    current = base
    for part in relative.parts[:-1]:
        current /= part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise RuntimeError(f"unsafe scratch parent: {name}")
    return base / relative


def archive(source_root: Path, destination: Path, fds: tuple[int, ...] = ()) -> None:
    staged = subprocess.run(["git", "diff", "--cached", "--quiet", "--"], cwd=source_root, check=False)
    if staged.returncode == 1:
        raise RuntimeError("scratch controls require an empty index")
    if staged.returncode != 0:
        raise RuntimeError("could not inspect the Git index")
    process = subprocess.Popen(["git", "archive", "--format=tar", "HEAD"], cwd=source_root,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=fds)
    assert process.stdout is not None and process.stderr is not None
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as source:
            source.extractall(destination, filter="data")
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        process.stdout.close()
    error = process.stderr.read().decode("utf-8", errors="replace")
    if process.wait() != 0:
        raise RuntimeError(f"git archive failed: {error}")
    coverage = scratch_path(source_root, "spec/formal/authority/coverage.json")
    if coverage.is_symlink() or not coverage.is_file():
        raise RuntimeError("unreviewed scratch coverage path")
    reviewed = json.loads(coverage.read_text())
    paths = [entry["path"] for entry in reviewed["sources"] + reviewed["optional_sources"]]
    for command in (["git", "diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
                    ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        names = subprocess.run(command, cwd=source_root, check=True, stdout=subprocess.PIPE).stdout.split(b"\0")
        paths.extend(os.fsdecode(name) for name in names if name)
    for name in dict.fromkeys(paths):
        source, target = scratch_path(source_root, name), scratch_path(destination, name)
        if source.is_symlink():
            raise RuntimeError(f"unexpected symlink in {name}")
        if not source.exists():
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                raise RuntimeError(f"unexpected scratch target in {name}")
            continue
        if not source.is_file() or target.is_symlink():
            raise RuntimeError(f"unexpected scratch source in {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def check(scratch: Path, env: dict[str, str], fd: int) -> subprocess.CompletedProcess[str]:
    # The nested workspace's unique target is inside the leased checkout, so
    # a surviving compiler holds the lease and a later owner removes remnants.
    return subprocess.run(["bash", "spec/formal/authority/check.sh"], cwd=scratch,
                          env=env | {"TMPDIR": str(scratch)}, text=True, capture_output=True,
                          timeout=600, pass_fds=(fd,), check=False)


def main() -> None:
    env = os.environ.copy()
    env.pop("OPENSESAME_FORMAL_SCRATCH_LOCK_FD", None)
    subprocess.run([sys.executable, "-I", str(model / "check-drift.py")], cwd=root,
                   env=env, check=True, timeout=60)
    helper = root / "scripts/security/formal-cargo-isolation.py"
    isolation = {"__name__": "formal_cargo_isolation", "__file__": str(helper)}
    exec(compile(helper.read_bytes(), str(helper), "exec", dont_inherit=True), isolation)
    with isolation["scratch_checkout"](root) as lease:
        scratch, fd = lease.path, lease.lock_fd
        env["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(fd)
        # The archived tree has no .git; reviewed_revision lineage resolves
        # against this repository, which the live baseline check verified.
        env["OPENSESAME_FORMAL_GIT_ROOT"] = str(root)
        archive(root, scratch, (fd,))
        destination = scratch / "spec/formal/authority"
        baseline = check(scratch, env, fd)
        if baseline.returncode:
            raise RuntimeError("scratch baseline failed:\n" + (baseline.stdout + baseline.stderr)[-2000:])
        for name, relative, before, after in mutations:
            source = scratch / relative
            with isolation["mutated_coverage"](
                scratch, destination / "coverage.json", source, before, after,
                destination / "check-drift.py", env=env,
            ):
                result = check(scratch, env, fd)
            output = result.stdout + result.stderr
            if result.returncode != 101 or "assertion `left == right` failed" not in output or "vector:" not in output:
                raise RuntimeError(f"{name}: no corresponding assertion failed:\n{output[-2000:]}")
            counterexample = next(line.strip() for line in output.splitlines()
                                  if line.startswith("assertion `left == right` failed: vector:"))
            print(f"{name}: exit 101; {counterexample}", flush=True)
        restored = check(scratch, env, fd)
        if restored.returncode:
            raise RuntimeError("restored baseline failed:\n" + (restored.stdout + restored.stderr)[-2000:])
        print("Restored baseline passed.", flush=True)

if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f"authority-negative-controls: {error}") from error
