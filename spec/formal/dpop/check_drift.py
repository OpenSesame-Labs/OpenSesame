#!/usr/bin/env python3
"""Check the manually reviewed source correspondence, not its correctness."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[3]
coverage = json.loads((root / "spec/formal/dpop/coverage.json").read_text())
paths = [
    "crates/proof/src/replay.rs",
    "crates/proof/src/validator.rs",
    "crates/proof/src/jwk.rs",
    "spec/formal/dpop/replay_conformance.rs",
]
if (
    coverage.get("version") != 1
    or not re.fullmatch(r"[0-9a-f]{40}", coverage.get("reviewed_revision", ""))
    or [entry.get("path") for entry in coverage.get("sources", [])] != paths
):
    raise SystemExit("dpop-formal: invalid covered-source manifest")
for entry in coverage["sources"]:
    digest = hashlib.sha256((root / entry["path"]).read_bytes()).hexdigest()
    if digest != entry.get("sha256"):
        raise SystemExit(f"dpop-formal: source drift in {entry['path']}; review model and update coverage.json")
print(f"dpop-formal: source hashes match reviewed revision {coverage['reviewed_revision']}")
