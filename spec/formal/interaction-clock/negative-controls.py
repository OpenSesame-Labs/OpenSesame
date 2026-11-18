#!/usr/bin/env python3
"""Confirm the deadline correspondence rejects isolated broken helpers."""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "packages/control-plane/src/services/interaction-clock.ts"
CASES = {
    "expiry-equality": ("sampledAt < deadline", "sampledAt <= deadline"),
    "inverted-deadline": ("sampledAt < deadline", "sampledAt > deadline"),
    "unchecked-deadline": ("sampledAt < deadline", "true"),
    "ignore-interaction-deadline": ("!isLiveAt(interactionDeadline, now)", "false"),
    "ignore-activation-deadline": ("!isLiveAt(activationDeadline, now)", "false"),
}


def main() -> None:
    env = os.environ.copy()
    env.pop("OPENSESAME_INTERACTION_CLOCK_MUTANT", None)
    runner = ["bash", str(ROOT / "spec/formal/interaction-clock/verify.sh")]
    subprocess.run(runner, cwd=ROOT, env=env, check=True)
    original = SOURCE.read_text()
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="clock-negative-", dir=work) as directory:
        scratch = Path(directory)
        module = scratch / "interaction-clock.ts"
        vectors = scratch / "vectors.tsv"
        lean = env.get("OPENSESAME_LEAN_BIN", "lean")
        with vectors.open("w") as output:
            subprocess.run(
                [lean, "-DwarningAsError=true", "--run", str(ROOT / "spec/formal/interaction-clock/InteractionClock.lean")],
                cwd=ROOT, env=env, stdout=output, check=True,
            )
        for name, (before, after) in CASES.items():
            if original.count(before) != 1:
                raise RuntimeError(f"{name}: mutation point is not unique")
            module.write_text(original.replace(before, after, 1))
            trial = env | {
                "OPENSESAME_INTERACTION_CLOCK_MUTANT": str(module),
                "OPENSESAME_INTERACTION_CLOCK_VECTORS": str(vectors),
            }
            result = subprocess.run(
                [str(ROOT / "node_modules/.bin/vitest"), "run", "--config", "spec/formal/interaction-clock/vitest.config.ts", "--maxWorkers=2"],
                cwd=ROOT, env=trial, capture_output=True, text=True,
            )
            if result.returncode == 0 or "AssertionError" not in result.stdout + result.stderr:
                raise RuntimeError(f"{name}: no correspondence assertion failed")
            print(f"{name}: caught by correspondence assertion", flush=True)
        refused = subprocess.run(runner, cwd=ROOT, env=trial, capture_output=True, text=True)
        if refused.returncode == 0:
            raise RuntimeError("verification command accepted a mutation override")
    if SOURCE.read_text() != original:
        raise RuntimeError("Product source changed during negative controls")
    subprocess.run(runner, cwd=ROOT, env=env, check=True)


if __name__ == "__main__":
    main()
