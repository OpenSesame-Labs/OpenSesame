"""Shared formal coverage drift checks (worktree hashes + main-lineage reviewed_revision)."""
from __future__ import annotations

from hashlib import sha256
import os
from pathlib import Path
import re
import subprocess


def lineage_git_root(root: Path) -> Path:
    """Resolve the checkout whose git metadata answers lineage checks.

    Archived negative-control scratch trees carry no `.git`; the harness
    exports OPENSESAME_FORMAL_GIT_ROOT so reviewed_revision lineage still
    resolves against the owning repository. A root with its own `.git` always
    wins, so the override can never redirect lineage for a real checkout.
    """
    if (root / ".git").exists():
        return root
    override = os.environ.get("OPENSESAME_FORMAL_GIT_ROOT")
    if override is not None:
        candidate = Path(override)
        if not (candidate / ".git").exists():
            raise SystemExit(
                "formal coverage drift: OPENSESAME_FORMAL_GIT_ROOT does not name a git checkout"
            )
        return candidate
    return root


def assert_reviewed_revision_on_main(root: Path, revision: str, label: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit(f"{label}: invalid reviewed_revision")
    git_root = lineage_git_root(root)
    try:
        subprocess.run(
            ["git", "-C", str(git_root), "cat-file", "-e", f"{revision}^{{commit}}"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"{label}: unknown reviewed revision {revision}") from exc
    main = (
        subprocess.check_output(["git", "-C", str(git_root), "rev-parse", "origin/main"])
        .decode()
        .strip()
    )
    if (
        subprocess.run(
            ["git", "-C", str(git_root), "merge-base", "--is-ancestor", revision, main],
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