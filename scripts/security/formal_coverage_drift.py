"""Shared formal coverage drift checks (worktree hashes + main-lineage reviewed_revision)."""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import re
import subprocess


def assert_reviewed_revision_on_main(root: Path, revision: str, label: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit(f"{label}: invalid reviewed_revision")
    try:
        subprocess.run(
            ["git", "-C", str(root), "cat-file", "-e", f"{revision}^{{commit}}"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"{label}: unknown reviewed revision {revision}") from exc
    main = (
        subprocess.check_output(["git", "-C", str(root), "rev-parse", "origin/main"])
        .decode()
        .strip()
    )
    if (
        subprocess.run(
            ["git", "-C", str(root), "merge-base", "--is-ancestor", revision, main],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        != 0
    ):
        raise SystemExit(
            f"{label}: reviewed_revision {revision} is not on origin/main; "
            "pin a main ancestor so squash merge does not drop the review commit"
        )


def assert_worktree_sources(root: Path, sources: list, label: str) -> None:
    for entry in sources:
        path = entry.get("path")
        expected = entry.get("sha256")
        digest = sha256((root / path).read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit(
                f"{label}: source drift in {path}; review the model before updating coverage.json"
            )