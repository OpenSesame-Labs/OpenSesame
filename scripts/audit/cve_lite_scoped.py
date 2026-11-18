"""Verify version-qualified npm overrides against locked dependency edges."""
import json
import subprocess
from pathlib import Path

from cve_lite_alias import verified_alias


SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
SEMVER = Path(__file__).with_name("cve-lite-semver.mjs")


def parent_matches_lock(metadata, entry, location):
    expected = entry.get("name")
    if expected is None and "node_modules/" in location:
        expected = location.rsplit("node_modules/", 1)[1]
    if expected is not None and metadata.get("name") != expected:
        return False
    return not entry.get("version") or metadata.get("version") == entry["version"]


def installed_dependency(root, parent, name):
    current = parent.resolve()
    while current.is_relative_to(root):
        candidate = current / "node_modules" / name
        if current.name != "node_modules" and (candidate / "package.json").is_file():
            return candidate
        if current == root:
            break
        current = current.parent
    return None


def matching_selector(finding, manifest):
    if finding.get("ruleId") not in ("OA004", "OA006", "OA008"):
        return None
    name = finding.get("package", {}).get("name")
    pointer = finding.get("location", {}).get("jsonPath")
    if not isinstance(name, str) or not isinstance(pointer, str) or not pointer.startswith("/overrides/"):
        return None
    escaped = pointer[len("/overrides/"):]
    if "/" in escaped:
        return None
    key = escaped.replace("~1", "/").replace("~0", "~")
    prefix = name + "@"
    if not key.startswith(prefix) or not key[len(prefix):]:
        return None
    pin = manifest.get("overrides", {}).get(key)
    if not isinstance(pin, str):
        return None
    return name, key[len(prefix):], pin


def lock_package_name(location, entry):
    if isinstance(entry.get("name"), str):
        return entry["name"]
    marker = "node_modules/"
    return location.rsplit(marker, 1)[1] if marker in location else None


def prove_scoped_override(finding, root, manifest, lock, executable):
    selector_data = matching_selector(finding, manifest)
    if selector_data is None or not executable:
        return False
    name, selector, pin = selector_data
    alias = None
    if pin.startswith("$"):
        alias = verified_alias(root, manifest, lock, pin[1:], name)
        if alias is None:
            return False
        pin = alias["version"]
    try:
        packages = lock["packages"]
        occurrences = []
        for location, entry in packages.items():
            if lock_package_name(location, entry) != name:
                continue
            package_dir = root / location
            if not package_dir.resolve().is_relative_to(root):
                return False
            metadata = json.loads((package_dir / "package.json").read_text())
            version = entry.get("version")
            if metadata.get("name") != name or metadata.get("version") != version:
                return False
            occurrences.append((entry, version))
        if not occurrences:
            return False
        process = subprocess.run(
            ["node", str(SEMVER), str(executable)],
            input=json.dumps({"checks": [
                {"spec": selector, "version": version} for _, version in occurrences
            ] + [{"spec": pin, "version": pin}]}),
            text=True, capture_output=True, check=True, timeout=30,
        )
        results = json.loads(process.stdout)
        if (not isinstance(results, list) or len(results) != len(occurrences) + 1
                or any(type(item) is not bool for item in results) or results[-1] is not True):
            return False
        checked = 0
        for (entry, version), matches in zip(occurrences, results[:-1]):
            if not matches:
                continue
            if version != pin:
                return False
            if alias and (entry.get("resolved") != alias["spec"]
                          or entry.get("integrity") != alias["integrity"]):
                return False
            checked += 1
        return checked > 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return False
