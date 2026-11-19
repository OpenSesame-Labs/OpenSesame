from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[3]
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
    or not re.fullmatch(r"[0-9a-f]{40}", revision)
    or [entry.get("path") for entry in manifest.get("sources", [])] != paths
):
    raise SystemExit("authority-formal: invalid coverage manifest")
try:
    subprocess.run(
        ["git", "-C", str(root), "cat-file", "-e", f"{revision}^{{commit}}"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
except subprocess.CalledProcessError as exc:
    raise SystemExit(f"authority-formal: unknown reviewed revision {revision}") from exc
env = {**os.environ.copy(), "GIT_NO_REPLACE_OBJECTS": "1"}
for entry in manifest["sources"]:
    path = entry["path"]
    try:
        reviewed = subprocess.check_output(
            ["git", "-C", str(root), "show", f"{revision}:{path}"],
            env=env,
            timeout=60,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            f"authority-formal: reviewed revision missing source {path}"
        ) from exc
    reviewed_digest = sha256(reviewed).hexdigest()
    if reviewed_digest != entry.get("sha256"):
        raise SystemExit(
            f"authority-formal: reviewed revision does not match {path}"
        )
    worktree_digest = sha256((root / path).read_bytes()).hexdigest()
    if worktree_digest != entry.get("sha256"):
        raise SystemExit(
            f"authority-formal: source drift in {path}; review the model before updating coverage.json"
        )
print(f"authority-formal: covered sources match reviewed revision {revision}")