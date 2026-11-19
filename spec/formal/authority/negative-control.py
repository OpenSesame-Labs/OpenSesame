#!/usr/bin/env python3
"""Run guarded mutants in a separate temporary worktree and restore it."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
model = root / "spec/formal/authority"
manifest = json.loads((model / "coverage.json").read_text())
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
]


def check(scratch: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "spec/formal/authority/check.sh"], cwd=scratch,
                          env=os.environ.copy(), text=True, capture_output=True)


with tempfile.TemporaryDirectory(prefix="opensesame-authority-mutants-") as temporary:
    scratch = Path(temporary) / "checkout"
    added = False
    try:
        subprocess.run(["git", "-C", str(root), "worktree", "add", "--detach", str(scratch), "HEAD"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        added = True
        destination = scratch / "spec/formal/authority"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(model, destination, dirs_exist_ok=True)
        for entry in manifest["sources"]:
            shutil.copy2(root / entry["path"], scratch / entry["path"])
        baseline = check(scratch)
        if baseline.returncode:
            raise RuntimeError("scratch baseline failed:\n" + (baseline.stdout + baseline.stderr)[-2000:])
        for name, relative, before, after in mutations:
            source = scratch / relative
            original = source.read_bytes()
            text = original.decode()
            if text.count(before) != 1:
                raise RuntimeError(f"{name}: mutation point is absent or ambiguous")
            try:
                source.write_text(text.replace(before, after, 1))
                result = check(scratch)
            finally:
                source.write_bytes(original)
            output = result.stdout + result.stderr
            if result.returncode == 0 or "assertion `left == right` failed" not in output or "vector:" not in output:
                raise RuntimeError(f"{name}: no corresponding assertion failed:\n{output[-2000:]}")
            counterexample = next(line.strip() for line in output.splitlines()
                                  if line.startswith("assertion `left == right` failed: vector:"))
            print(f"{name}: {counterexample}", flush=True)
        restored = check(scratch)
        if restored.returncode:
            raise RuntimeError("restored baseline failed:\n" + (restored.stdout + restored.stderr)[-2000:])
        print("Restored baseline passed.", flush=True)
    finally:
        if added:
            subprocess.run(["git", "-C", str(root), "worktree", "remove", "--force", str(scratch)], check=True)
