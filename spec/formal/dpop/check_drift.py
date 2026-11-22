#!/usr/bin/env python3
"""Check the manually reviewed source correspondence, not its correctness."""
from __future__ import annotations

import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / "scripts" / "security"))
from formal_coverage_drift import (  # noqa: E402
    assert_reviewed_revision_on_main,
    assert_worktree_sources,
)

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
    or [entry.get("path") for entry in coverage.get("sources", [])] != paths
):
    raise SystemExit("dpop-formal: invalid covered-source manifest")
assert_reviewed_revision_on_main(root, revision, "dpop-formal")
assert_worktree_sources(root, coverage["sources"], "dpop-formal")
print(
    f"dpop-formal: source hashes match reviewed revision {revision} (origin/main lineage)"
)