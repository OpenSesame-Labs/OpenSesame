#!/usr/bin/env python3
"""Check that the approval correspondence rejects broken scratch copies."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "packages/os-domain/src/machines/interaction.ts"
ERRORS = ROOT / "packages/os-domain/src/errors.ts"
CASES = {
    "digest-mismatch": [("input.proof.boundDigest !== interaction.requestDigest", "false && input.proof.boundDigest !== interaction.requestDigest")],
    "required-digest": [("KINDS_REQUIRING_DIGEST.has(interaction.kind)", "false && KINDS_REQUIRING_DIGEST.has(interaction.kind)")],
    "empty-operation-digest": [("interaction.requestDigest.length === 0", "false")],
    "uncheckable-digest": [("input.proof.boundDigest.length > 0", "false && input.proof.boundDigest.length > 0")],
    "expiry-boundary": [("return current >= deadline;", "return current > deadline;")],
    "unreadable-expiry": [("if (!Number.isFinite(deadline)) return true;", "if (!Number.isFinite(deadline)) return false;")],
    "unreadable-clock": [("if (!Number.isFinite(current)) return true;", "if (!Number.isFinite(current)) return false;")],
    "approval-transition": [('pending: ["presented", "awaiting_approval", "denied", "expired", "revoked"],', 'pending: ["presented", "awaiting_approval", "denied", "expired", "revoked", "approved"],')],
    "repeat-consume": [('consumed: [],', 'consumed: ["consumed"],'), ('if (interaction.status !== "approved") {', 'if (false && interaction.status !== "approved") {')],
}


def main() -> None:
    env = os.environ.copy()
    env.pop("OPENSESAME_APPROVAL_MUTANT", None)
    original = SOURCE.read_text()
    runner = ["bash", str(ROOT / "spec/formal/webauthn/verify.sh")]
    subprocess.run(runner, cwd=ROOT, env=env, check=True)
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="approval-negative-", dir=work) as directory:
        scratch = Path(directory)
        module = scratch / "src/machines/interaction.ts"
        module.parent.mkdir(parents=True)
        shutil.copy2(ERRORS, scratch / "src/errors.ts")
        vectors = scratch / "vectors.tsv"
        lean = env.get("OPENSESAME_LEAN_BIN", "lean")
        with vectors.open("w") as out:
            subprocess.run([lean, "-DwarningAsError=true", "--run", str(ROOT / "spec/formal/webauthn/ApprovalBinding.lean")],
                           cwd=ROOT / "spec/formal/auth", env=env, stdout=out, check=True)
        for name, replacements in CASES.items():
            mutant = original
            for before, after in replacements:
                if mutant.count(before) != 1:
                    raise RuntimeError(f"{name}: mutation point is not unique")
                mutant = mutant.replace(before, after, 1)
            module.write_text(mutant)
            trial_env = env | {
                "OPENSESAME_APPROVAL_MUTANT": str(module),
                "OPENSESAME_APPROVAL_VECTORS": str(vectors),
            }
            result = subprocess.run(
                [str(ROOT / "node_modules/.bin/vitest"), "run", "--config", "spec/formal/webauthn/vitest.config.ts", "--maxWorkers=2"],
                cwd=ROOT, env=trial_env, capture_output=True, text=True,
            )
            if result.returncode == 0 or "AssertionError" not in result.stdout + result.stderr:
                raise RuntimeError(f"{name}: no correspondence assertion failed (exit {result.returncode})")
            print(f"{name}: caught by correspondence assertion", flush=True)
    if SOURCE.read_text() != original:
        raise RuntimeError("Product source changed during scratch mutation tests")
    subprocess.run(runner, cwd=ROOT, env=env, check=True)


if __name__ == "__main__":
    main()
