"""Scratch trees for formal drift-check tests, with their own git lineage.

Drift checkers resolve `reviewed_revision` against `origin/main` and read
reviewed blobs from the checkout they run in. A scratch copy without `.git`
therefore fails on lineage before it reaches the property a test exercises.
`init_checkout` makes the scratch tree its own git repository that borrows
this repository's objects (alternates) and tracks this repository's
`origin/main`, so the real checkers run unmodified against it. `scrubbed_env`
drops GIT_* variables (a hook's GIT_DIR or GIT_INDEX_FILE) so neither the
helper nor a checker it starts can be redirected to another repository.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess


def scrubbed_env(base: dict[str, str] | None = None) -> dict[str, str]:
    source = os.environ if base is None else base
    return {key: value for key, value in source.items() if not key.startswith("GIT_")}


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], env=scrubbed_env(), text=True).strip()


def init_checkout(target: Path, root: Path) -> None:
    """Make `target` a git checkout using `root`'s objects and origin/main."""
    common = Path(git("-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"))
    main = git("-C", str(root), "rev-parse", "origin/main")
    git("init", "-q", str(target))
    (target / ".git/objects/info/alternates").write_text(f"{common / 'objects'}\n")
    git("-C", str(target), "update-ref", "refs/remotes/origin/main", main)


def store_blob(target: Path, path: Path) -> str:
    """Write `path`'s bytes into the scratch object store and return the blob id."""
    return git("-C", str(target), "hash-object", "-w", str(path))


def coverage_files(root: Path, coverage: str) -> set[str]:
    """Paths a suite's coverage names: itself, sources, present optional sources, attestation."""
    document = json.loads((root / coverage).read_text())
    names = {coverage}
    for entry in document["sources"] + document.get("optional_sources", []):
        if (root / entry["path"]).is_file():
            names.add(entry["path"])
    if "reviewed_attestation" in document:
        names.add(document["reviewed_attestation"])
    return names


def tracked_files(root: Path, *pathspecs: str) -> set[str]:
    """Tracked paths under `pathspecs` that exist in `root`'s working tree."""
    output = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z", "--", *pathspecs],
                                     env=scrubbed_env())
    return {name for name in output.decode().split("\0") if name and (root / name).is_file()}


def copy_files(root: Path, target: Path, names: set[str]) -> None:
    """Copy regular working-tree files; a symlinked source is refused."""
    for name in sorted(names):
        source, destination = root / name, target / name
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"scratch source is not a regular file: {name}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
