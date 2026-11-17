"""Prove narrowly scoped scanner false positives using the TypeScript AST."""
import json
import subprocess
from pathlib import Path

from cve_lite_scoped import installed_dependency


PROOF = Path(__file__).with_name("cve-lite-phantom-proof.mjs")
SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")


def app_core_declares(root, lock, name):
    package_dir = root / "packages/app-core"
    metadata = json.loads((package_dir / "package.json").read_text())
    entry = lock["packages"]["packages/app-core"]
    specs = {metadata.get(section, {}).get(name) for section in SECTIONS}
    specs.discard(None)
    locked_specs = {entry.get(section, {}).get(name) for section in SECTIONS}
    locked_specs.discard(None)
    if len(specs) != 1 or specs != locked_specs:
        return False
    installed = installed_dependency(root, package_dir, name)
    if not installed or not installed.resolve().is_relative_to(root):
        return False
    installed_manifest = json.loads((installed / "package.json").read_text())
    locked = lock["packages"].get(installed.relative_to(root).as_posix(), {})
    return installed_manifest.get("name") == name and installed_manifest.get("version") == locked.get("version")


def proven_indirect_import(root, lock, name, path):
    try:
        result = subprocess.run(
            ["node", str(PROOF), str(root), path, name], text=True,
            capture_output=True, check=True, timeout=30,
        )
        proof = json.loads(result.stdout)
        if proof == {"kind": "analyzer-fixture"}:
            return True
        if proof == {"kind": "app-core-bundle"}:
            return app_core_declares(root, lock, name) and app_core_declares(root, lock, "esbuild")
        if proof != {"kind": "app-core"}:
            return False
        return app_core_declares(root, lock, name)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return False
