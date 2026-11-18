"""Check each installed consumer of an overridden package against its own range."""
import json
import hashlib
import subprocess
from pathlib import Path

from cve_lite_alias import verified_alias
from cve_lite_scoped import SEMVER, installed_dependency, parent_matches_lock


PROMPTFOO = {
    "version": "0.125.1",
    "resolved": "https://registry.npmjs.org/promptfoo/-/promptfoo-0.125.1.tgz",
    "integrity": "sha512-nogBhixdp69icwkg1EI0syZ4zAmAjJyWeLcqxAkTldbHi0qirOslwHvkUQhQmg65lQLrIKyMOMLXlBlSc6LRrg==",
}
HONO = {
    "version": "2.1.6",
    "resolved": "https://registry.npmjs.org/@hono/node-server/-/node-server-2.1.6.tgz",
    "integrity": "sha512-p/KH9MnfNcsm3sR6x4lNgm5j+QN4Et8srKredl9DZfXiyZ1UQ3aQ2YVpFLbqktYN5JI+DB+VZFKM2PqE5hLKjQ==",
}
EDGE_REGRESSION_SHA256 = "4ae72c7ea9fc851c1d1e14568f4c867567229279ebe26af712de7611b23b1139"


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


def reviewed_promptfoo_hono_edge(root, manifest, lock, location, name, spec, version):
    """Allow only the source-pinned Promptfoo 2.1.5 -> genuine Hono 2.1.6 repair."""
    if (location, name, spec, version) != (
            "node_modules/promptfoo", "@hono/node-server", "2.1.5", "2.1.6"):
        return False
    try:
        packages = lock["packages"]
        promptfoo = packages[location]
        hono = packages["node_modules/@hono/node-server"]
        regression = root / "scripts/security/dependency-override-upgrade.test.mjs"
        occurrences = [(path, entry) for path, entry in packages.items()
                       if (entry.get("name") == name or path.endswith(f"node_modules/{name}"))]
        return (
            manifest.get("overrides", {}).get("promptfoo", {}).get(name) == HONO["version"]
            and all(promptfoo.get(field) == value for field, value in PROMPTFOO.items())
            and promptfoo.get("dependencies", {}).get(name) == spec
            and all(hono.get(field) == value for field, value in HONO.items())
            and len(occurrences) == 1
            and occurrences[0][0] == "node_modules/@hono/node-server"
            and hashlib.sha256(regression.read_bytes()).hexdigest() == EDGE_REGRESSION_SHA256
        )
    except (OSError, KeyError, TypeError, AttributeError):
        return False


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
                metadata_spec = metadata.get(section, {}).get(name)
                if not isinstance(spec, str) or not isinstance(metadata_spec, str):
                    errors.append(f"parent dependency differs from lockfile: {location} {name}")
                    continue
                if metadata_spec != spec:
                    # npm rewrites lockfile edge ranges to an exact root override. Only
                    # accept that normalization when the root override matches exactly;
                    # compatibility is still checked against the published range.
                    if manifest.get("overrides", {}).get(name) != spec:
                        errors.append(f"parent dependency differs from lockfile: {location} {name}")
                        continue
                    spec = metadata_spec
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
            if compatible is not True and not reviewed_promptfoo_hono_edge(
                    root, manifest, lock, location, name, spec, version):
                errors.append(f"{location or '<root>'} requires {name} {spec}, resolved {version}")
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
        errors.append(f"could not verify consumer edges: {error}")
    return errors
