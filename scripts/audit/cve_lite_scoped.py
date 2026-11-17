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
        edges = []
        for location, entry in packages.items():
            sections = tuple(section for section in SECTIONS if section != "devDependencies" or
                             "node_modules" not in Path(location).parts)
            specs = {entry.get(section, {}).get(name) for section in sections}
            specs.discard(None)
            if not specs:
                continue
            if len(specs) != 1:
                return False
            spec = specs.pop()
            if not isinstance(spec, str):
                return False
            parent = root / location
            if not parent.resolve().is_relative_to(root):
                return False
            if not (parent / "package.json").exists() and entry.get("optional") is True:
                continue
            metadata = json.loads((parent / "package.json").read_text())
            actual_specs = {metadata.get(section, {}).get(name) for section in sections}
            actual_specs.discard(None)
            if actual_specs != {spec} or not parent_matches_lock(metadata, entry, location):
                return False
            edges.append((parent, spec))
        if not edges:
            return False
        specs = []
        for _, spec in edges:
            if spec.startswith("file:"):
                if alias is None or spec != alias["spec"]:
                    return False
                specs.append(pin)
            else:
                specs.append(spec)
        process = subprocess.run(
            ["node", str(SEMVER), str(executable)],
            input=json.dumps({"selector": selector, "pin": pin, "specs": specs}),
            text=True, capture_output=True, check=True, timeout=30,
        )
        results = json.loads(process.stdout)
        if not isinstance(results, list) or len(results) != len(edges) or any(item is None for item in results):
            return False
        checked = 0
        for (parent, spec), result in zip(edges, results):
            if not isinstance(result, dict) or type(result.get("matches")) is not bool:
                return False
            if spec.startswith("file:"):
                result = {"matches": True, "acceptsPin": True}
            if not result["matches"]:
                continue
            resolved = installed_dependency(root, parent, name)
            if not resolved or not resolved.resolve().is_relative_to(root) or result.get("acceptsPin") is not True:
                return False
            metadata = json.loads((resolved / "package.json").read_text())
            locked = packages.get(resolved.relative_to(root).as_posix(), {})
            if metadata.get("name") != name or metadata.get("version") != pin or locked.get("version") != pin:
                return False
            if alias and (locked.get("resolved") != alias["spec"] or locked.get("integrity") != alias["integrity"]):
                return False
            checked += 1
        return checked > 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return False
