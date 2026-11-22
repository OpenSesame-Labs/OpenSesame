#!/usr/bin/env python3
"""Exercise the complete OAuth gate with missing hosted tests in a scratch tree."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
TEST_PATH = Path("packages/control-plane/src/__tests__/federated-interaction.test.ts")
TITLES = (
    "admits the subject and joins it to the tenant",
    "refuses an in-flight sign-in if the issuer changes organizations",
)
COPY = object()
SKELETON = {
    "packages": {
        "control-plane": {"src": {"__tests__": {TEST_PATH.name: COPY}}},
    },
    "spec": {"formal": {"oauth": COPY, "check-axioms.sh": COPY}},
}


def mirror(source, destination, exceptions):
    """Link unchanged inputs and copy the files mutated or executed by this check."""
    destination.mkdir()
    for entry in source.iterdir():
        if entry.name == ".git":
            continue
        target = destination / entry.name
        exception = exceptions.get(entry.name)
        if exception is COPY:
            if entry.is_dir():
                shutil.copytree(entry, target, symlinks=True)
            else:
                shutil.copy2(entry, target)
        elif isinstance(exception, dict):
            mirror(entry, target, exception)
        else:
            target.symlink_to(entry, target_is_directory=entry.is_dir())


def run_gate(root, env):
    return subprocess.run(
        ["bash", "spec/formal/oauth/verify.sh"],
        cwd=root,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def mutate(original, replacements):
    result = original
    for title, replacement in replacements:
        before = f'it("{title}",'
        if result.count(before) != 1:
            raise SystemExit(f"mutation target must be unique: {title}")
        result = result.replace(before, replacement, 1)
    return result


env = os.environ.copy()
env.pop("OPENSESAME_OAUTH_MUTANT", None)
original = (ROOT / TEST_PATH).read_text()
cases = []
for title in TITLES:
    # The rename still matches Vitest's substring filter. The structured report
    # must reject the changed identity even though that test continues to run.
    cases.append((f"renamed {title}", [(title, f'it("{title} (renamed)",')]))
    cases.append((f"skipped {title}", [(title, f'it.skip("{title}",')]))
cases.append(
    (
        "no selected tests",
        [
            (title, f'it("unselected hosted-flow case {index}",')
            for index, title in enumerate(TITLES)
        ],
    )
)

with tempfile.TemporaryDirectory(prefix="oauth-hosted-negative-") as temporary:
    scratch = Path(temporary) / "checkout"
    mirror(ROOT, scratch, SKELETON)
    test_file = scratch / TEST_PATH
    baseline = run_gate(scratch, env)
    if baseline.returncode != 0:
        raise SystemExit(f"unmodified scratch gate failed:\n{baseline.stdout}")
    print("unmodified scratch gate passed", flush=True)
    for name, replacements in cases:
        test_file.write_text(mutate(original, replacements))
        result = run_gate(scratch, env)
        expected = "oauth-formal: hosted-flow report "
        if result.returncode == 0 or expected not in result.stdout:
            raise SystemExit(f"{name}: gate did not reject the report:\n{result.stdout}")
        if len(replacements) == 1:
            diagnostic = (
                "requires exactly one passing result for "
                "federated leg, organization sign-in / " + replacements[0][0]
            )
            if diagnostic not in result.stdout:
                raise SystemExit(
                    f"{name}: gate rejected for an unrelated reason:\n{result.stdout}"
                )
        print(f"{name}: detected", flush=True)
