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

manifest = json.loads((root / "spec/formal/authority/coverage.json").read_text())
paths = [
    "spec/formal/authority/Cargo.toml",
    "spec/formal/authority/Cargo.lock",
    "spec/formal/authority/conformance.rs",
    "crates/domain/Cargo.toml",
    "crates/domain/src/grant.rs",
    "crates/domain/src/grant_attenuation.rs",
    "crates/domain/src/grant_budgets.rs",
    "crates/domain/src/grant_lineage.rs",
    "crates/domain/src/ids.rs",
]
revision = str(manifest.get("reviewed_revision", ""))
if (
    manifest.get("version") != 1
    or [entry.get("path") for entry in manifest.get("sources", [])] != paths
):
    raise SystemExit("authority-formal: invalid coverage manifest")
assert_reviewed_revision_on_main(root, revision, "authority-formal")
assert_worktree_sources(root, manifest["sources"], "authority-formal")
print(
    f"authority-formal: covered sources match reviewed revision {revision} (origin/main lineage)"
)