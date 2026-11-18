from hashlib import sha256
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[3]
manifest = json.loads((root / "spec/formal/authority/coverage.json").read_text())
paths = [
    "Cargo.toml",
    "Cargo.lock",
    "crates/domain/Cargo.toml",
    "crates/domain/src/grant.rs",
    "crates/domain/src/grant_attenuation.rs",
    "crates/domain/src/grant_budgets.rs",
    "crates/domain/src/grant_lineage.rs",
    "crates/domain/src/ids.rs",
]
if (manifest.get("version") != 1 or
        not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("reviewed_revision", ""))) or
        [entry.get("path") for entry in manifest.get("sources", [])] != paths):
    raise SystemExit("authority-formal: invalid coverage manifest")
for entry in manifest["sources"]:
    if sha256((root / entry["path"]).read_bytes()).hexdigest() != entry["sha256"]:
        raise SystemExit(f"authority-formal: source drift in {entry['path']}; review the model before updating coverage.json")
print(f"authority-formal: covered sources match reviewed revision {manifest['reviewed_revision']}")
