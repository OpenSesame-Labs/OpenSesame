#!/usr/bin/env python3
"""Check the manually reviewed source correspondence, not its correctness."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess

root = Path(__file__).resolve().parents[3]
coverage = json.loads((root / "spec/formal/dpop/coverage.json").read_text())
paths = [
    "crates/proof/src/replay.rs",
    "crates/proof/src/validator.rs",
    "crates/proof/src/jwk.rs",
    "spec/formal/dpop/replay_conformance.rs",
]
revision = str(coverage.get("reviewed_revision", ""))
if (
    coverage.get("version") != 1
    or not re.fullmatch(r"[0-9a-f]{40}", revision)
    or [entry.get("path") for entry in coverage.get("sources", [])] != paths
):
    raise SystemExit("dpop-formal: invalid covered-source manifest")
try:
    subprocess.run(
        ["git", "-C", str(root), "cat-file", "-e", f"{revision}^{{commit}}"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
except subprocess.CalledProcessError as exc:
    raise SystemExit(f"dpop-formal: unknown reviewed revision {revision}") from exc
env = {**os.environ.copy(), "GIT_NO_REPLACE_OBJECTS": "1"}
for entry in coverage["sources"]:
    path = entry["path"]
    try:
        reviewed = subprocess.check_output(
            ["git", "-C", str(root), "show", f"{revision}:{path}"],
            env=env,
            timeout=60,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"dpop-formal: reviewed revision missing source {path}") from exc
    reviewed_digest = hashlib.sha256(reviewed).hexdigest()
    if reviewed_digest != entry.get("sha256"):
        raise SystemExit(f"dpop-formal: reviewed revision does not match {path}")
    worktree_digest = hashlib.sha256((root / path).read_bytes()).hexdigest()
    if worktree_digest != entry.get("sha256"):
        raise SystemExit(
            f"dpop-formal: source drift in {entry['path']}; review model and update coverage.json"
        )
print(f"dpop-formal: source hashes match reviewed revision {revision}")