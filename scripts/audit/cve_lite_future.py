"""Retain explicitly reviewed defensive pins only while their targets are absent."""
import json
import os


def installed_names(root):
    names = set()
    visited = set()

    def package(directory, fallback):
        resolved = directory.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValueError("installed package leaves checkout")
        if resolved in visited:
            return
        visited.add(resolved)
        metadata_path = directory / "package.json"
        if not metadata_path.is_file():
            raise ValueError("installed package manifest missing")
        metadata = json.loads(metadata_path.read_text())
        if not isinstance(metadata.get("name"), str):
            raise ValueError("installed package has no name")
        names.update((fallback, metadata["name"]))
        modules(directory / "node_modules")

    def modules(directory):
        if not directory.exists():
            return
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                path = directory / entry.name
                if entry.name.startswith("@"):
                    with os.scandir(path) as scoped:
                        for member in scoped:
                            package(path / member.name, f"{entry.name}/{member.name}")
                else:
                    package(path, entry.name)

    modules(root / "node_modules")
    return names


def preventive_overrides(root, manifest, lock):
    policy_path = root / "scripts/audit/cve-lite-preventive-overrides.json"
    try:
        policy = json.loads(policy_path.read_text())
        records = policy["absent"]
        if not isinstance(records, list):
            raise ValueError("invalid preventive override policy")
        if not records:
            return {}
        locked = lock["packages"]
        installed = installed_names(root)
        accepted = {}
        for record in records:
            name = record["package"]
            pointer = "/overrides/" + name.replace("~", "~0").replace("/", "~1")
            if (not isinstance(name, str) or not name or record["path"] != pointer
                    or not isinstance(record["reason"], str) or not record["reason"].strip()
                    or pointer in accepted or manifest.get("overrides", {}).get(name) != record["value"]):
                raise ValueError("changed preventive override requires review")
            if name in installed or any(
                path == f"node_modules/{name}" or path.endswith(f"/node_modules/{name}") or entry.get("name") == name
                for path, entry in locked.items()
            ):
                raise ValueError(f"preventive override target returned: {name}")
            accepted[pointer] = record
        return accepted
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        raise ValueError(f"preventive override verification failed: {error}") from error


def is_preventive_finding(finding, policy):
    location = finding.get("location", {})
    pointer = location.get("jsonPath") if isinstance(location, dict) else None
    record = policy.get(pointer)
    if not record or finding.get("package", {}).get("name") != record["package"]:
        return False
    if finding.get("ruleId") == "OA001" and isinstance(record["value"], str):
        return True
    if finding.get("ruleId") != "OA005" or finding.get("subRuleId") != "OA005.b":
        return False
    if not isinstance(record["value"], dict):
        return False
    details = finding.get("details", "")
    return any(details == f'Outer parent {record["package"]} is not in the dependency tree. '
               f'The nested override "{child}" has no parent to apply to.' for child in record["value"])
