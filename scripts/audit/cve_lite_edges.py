"""Check each installed consumer of an overridden package against its own range."""
import json
import subprocess
from pathlib import Path

from cve_lite_alias import verified_alias
from cve_lite_scoped import SEMVER, installed_dependency, parent_matches_lock


def override_names(overrides):
    names = set()
    for key, value in overrides.items():
        if key == ".":
            continue
        at = key.rfind("@")
        names.add(key[:at] if at > 0 else key)
        if isinstance(value, dict):
            names.update(override_names(value))
    return names


def consumer_edges(root, manifest, lock, executable):
    errors = []
    edges = []
    try:
        packages = lock["packages"]
        targets = override_names(manifest["overrides"])
        for location, entry in packages.items():
            sections = ["dependencies", "optionalDependencies", "peerDependencies"]
            if "node_modules" not in Path(location).parts:
                sections.append("devDependencies")
            selected = [(section, name, spec) for section in sections
                        for name, spec in entry.get(section, {}).items() if name in targets
                        and not (section == "dependencies" and name in entry.get("optionalDependencies", {}))]
            if not selected:
                continue
            parent = root / location
            if not parent.resolve().is_relative_to(root):
                errors.append(f"parent leaves checkout: {location}")
                continue
            parent_manifest = parent / "package.json"
            if not parent_manifest.exists() and entry.get("optional") is True:
                continue
            if not parent_manifest.is_file():
                errors.append(f"missing parent manifest: {location}")
                continue
            try:
                metadata = json.loads(parent_manifest.read_text())
            except (OSError, ValueError):
                errors.append(f"unreadable parent manifest: {location}")
                continue
            if not parent_matches_lock(metadata, entry, location):
                errors.append(f"parent identity or version differs from lockfile: {location}")
                continue
            for section, name, spec in selected:
                if not isinstance(spec, str) or metadata.get(section, {}).get(name) != spec:
                    errors.append(f"parent dependency differs from lockfile: {location} {name}")
                    continue
                resolved = installed_dependency(root, parent, name)
                if not resolved:
                    optional_peer = entry.get("peerDependenciesMeta", {}).get(name, {}).get("optional") is True
                    if section != "optionalDependencies" and not optional_peer:
                        errors.append(f"missing dependency: {location} {name}")
                    continue
                if not resolved.resolve().is_relative_to(root):
                    errors.append(f"dependency leaves checkout: {location} {name}")
                    continue
                try:
                    installed = json.loads((resolved / "package.json").read_text())
                except (OSError, ValueError):
                    errors.append(f"unreadable dependency manifest: {location} {name}")
                    continue
                locked = packages.get(resolved.relative_to(root).as_posix(), {})
                version = installed.get("version")
                if not isinstance(version, str) or locked.get("version") != version:
                    errors.append(f"installed dependency differs from lockfile: {location} {name}")
                    continue
                if spec.startswith("file:"):
                    alias = verified_alias(root, manifest, lock, name, name)
                    if (not alias or alias["spec"] != spec or alias["version"] != version
                            or locked.get("resolved") != alias["spec"]
                            or locked.get("integrity") != alias["integrity"]):
                        errors.append(f"unverified file dependency: {location} {name}")
                    continue
                effective = spec
                actual_name = name
                if spec.startswith("npm:"):
                    target = spec[4:]
                    at = target.rfind("@")
                    if at <= 0:
                        errors.append(f"invalid npm alias: {location} {name}")
                        continue
                    actual_name, effective = target[:at], target[at + 1:]
                if installed.get("name") != actual_name:
                    errors.append(f"installed package identity mismatch: {location} {name}")
                    continue
                edges.append((location, name, spec, effective, version))
        if not edges:
            return errors
        result = subprocess.run(
            ["node", str(SEMVER), str(executable)],
            input=json.dumps({"checks": [{"spec": effective, "version": version}
                                         for _, _, _, effective, version in edges]}),
            text=True, capture_output=True, check=True, timeout=30,
        )
        checks = json.loads(result.stdout)
        if not isinstance(checks, list) or len(checks) != len(edges):
            raise ValueError("invalid npm semver check result")
        for (location, name, spec, _, version), compatible in zip(edges, checks):
            if compatible is not True:
                errors.append(f"{location or '<root>'} requires {name} {spec}, resolved {version}")
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
        errors.append(f"could not verify consumer edges: {error}")
    return errors
