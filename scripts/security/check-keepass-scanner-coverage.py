#!/usr/bin/env python3
"""Prove the configured OSV scanner includes the verified Keepass path dependency."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("verify_keepass", ROOT / "scripts/security/verify-vendored-keepass.py")
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)
TEST_ID = "RUSTSEC-2099-9998"


def check(scanner: Path) -> None:
    verification.verify(ROOT)
    advisory = {
        "schema_version": "1.7.0",
        "id": TEST_ID,
        "modified": "2026-11-17T00:00:00Z",
        "published": "2026-11-17T00:00:00Z",
        "summary": "Synthetic local scanner coverage fixture",
        "affected": [{
            "package": {"ecosystem": "crates.io", "name": "keepass"},
            "ranges": [{"type": "SEMVER", "events": [
                {"introduced": "0.17.0"}, {"fixed": "0.17.1"},
            ]}],
        }],
    }
    with tempfile.TemporaryDirectory(prefix="opensesame-keepass-osv-") as temporary:
        scratch = Path(temporary)
        database = scratch / "osv-scalibr/crates.io/all.zip"
        database.parent.mkdir(parents=True)
        with zipfile.ZipFile(database, "w") as output:
            output.writestr(TEST_ID + ".json", json.dumps(advisory))
        config = scratch / "osv-scanner.toml"
        config.write_text("IgnoredVulns = []\n")
        for manifest in verification.WORKSPACES:
            lockfile = ROOT / manifest.with_name("Cargo.lock")
            report = scratch / "report.json"
            result = subprocess.run([
                str(scanner), "scan", "source", "--offline",
                "--local-db-path=" + str(scratch), "--lockfile=" + str(lockfile),
                "--config=" + str(config), "--format=json", "--output-file=" + str(report),
            ], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode != 1 or not report.is_file():
                raise ValueError(f"{lockfile}: synthetic OSV scan did not report the fixture")
            data = json.loads(report.read_text())
            found = any(
                package.get("package", {}).get("name") == "keepass"
                and package.get("package", {}).get("version") == "0.17.0"
                and any(item.get("id") == TEST_ID for item in package.get("vulnerabilities", []))
                for scan_result in data.get("results", [])
                for package in scan_result.get("packages", [])
            )
            if not found:
                raise ValueError(f"{lockfile}: OSV did not scan the patched Keepass identity")
            report.unlink()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: check-keepass-scanner-coverage.py SCANNER")
        check(Path(sys.argv[1]).resolve(strict=True))
    except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print(f"Keepass scanner coverage: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print("Keepass scanner coverage: verified both lockfiles offline")
