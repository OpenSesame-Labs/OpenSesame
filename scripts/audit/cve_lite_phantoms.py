"""Prove narrowly scoped scanner false positives using the TypeScript AST."""
import json
import subprocess
from pathlib import Path

from cve_lite_alias import verified_alias
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


def reviewed_kdbx_resolver(root, lock):
    """Bind the resolver-only XML string to app-core's exact KDBX dependency edge."""
    if not app_core_declares(root, lock, "kdbxweb"):
        return False
    package_dir = installed_dependency(root, root / "packages/app-core", "kdbxweb")
    if not package_dir:
        return False
    metadata = json.loads((package_dir / "package.json").read_text())
    entry = lock["packages"][package_dir.relative_to(root).as_posix()]
    spec = metadata.get("dependencies", {}).get("@xmldom/xmldom")
    if spec != "0.8.15" or entry.get("dependencies", {}).get("@xmldom/xmldom") != spec:
        return False
    installed = installed_dependency(root, package_dir, "@xmldom/xmldom")
    if not installed:
        return False
    child = json.loads((installed / "package.json").read_text())
    locked = lock["packages"].get(installed.relative_to(root).as_posix(), {})
    return child.get("name") == "@xmldom/xmldom" and child.get("version") == locked.get("version") == spec


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
        if proof == {"kind": "kdbx-resolver"}:
            return name == "@xmldom/xmldom" and reviewed_kdbx_resolver(root, lock)
        if proof == {"kind": "patched-package-regression"}:
            aliases = {
                "@noble/post-quantum": "noble-post-quantum-patched",
                "@joshwooding/vite-plugin-react-docgen-typescript": "docgen-plugin-patched",
            }
            alias = aliases.get(name)
            manifest = json.loads((root / "package.json").read_text())
            return alias is not None and verified_alias(root, manifest, lock, alias, name) is not None
        if proof != {"kind": "app-core"}:
            return False
        return app_core_declares(root, lock, name)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return False
