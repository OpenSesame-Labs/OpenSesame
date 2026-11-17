#!/usr/bin/env python3
"""Verify both root-installed audit executables before running either one."""
import hashlib
import json
import os
import stat
import sys
from pathlib import Path


PINS = {
    "cve-lite-cli": {
        "version": "1.41.4", "bin": "cve-lite", "entry": "dist/index.js",
        "integrity": "sha512-3B/Q6S4acuq0RL4JikCUsC3XAlBFtDrEWOKwg9hmKzVsgRI3jpAPmxl8hHeNoQosLkW1wBYQktFjwWu1mcaQoA==",
        "tree": "b8a31d27ee566f10b45d11b28029d5b3606ad77cb11cd3d6bca83816d300a4e3",
    },
    "vitest": {
        "version": "4.1.12", "bin": "vitest", "entry": "vitest.mjs",
        "integrity": "sha512-5eWdz2yb3ajxWF3C8C4TjkXl7FGm3n2E/VlazALrQHzK7nYMSGFnCZto0bbPNl77AwkOZVLk0YnBAejUu0NiWA==",
        "tree": "f6f265b29043793c47eb36c4b369f633b96416f482c69494d2326a827618ad91",
    },
}


def package_tree_digest(directory):
    files = []
    for current, dirs, names in os.walk(directory, followlinks=False):
        current_path = Path(current)
        for name in list(dirs):
            child = current_path / name
            if child.is_symlink():
                raise ValueError("tool package contains a linked directory")
            if name == "node_modules":
                dirs.remove(name)
        for name in names:
            file = current_path / name
            if not stat.S_ISREG(file.lstat().st_mode):
                raise ValueError("tool package contains a non-regular file")
            files.append(file)
    digest = hashlib.sha256()
    for file in sorted(files, key=lambda path: path.relative_to(directory).as_posix()):
        digest.update(file.relative_to(directory).as_posix().encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(file.read_bytes()).digest())
        digest.update(b"\0")
    return digest.hexdigest()


def verify_tools(root):
    root = Path(root).resolve(strict=True)
    manifest = json.loads((root / "package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    for name, pin in PINS.items():
        spec = manifest.get("devDependencies", {}).get(name)
        entry = lock["packages"][f"node_modules/{name}"]
        expected_url = f"https://registry.npmjs.org/{name}/-/{name}-{pin['version']}.tgz"
        if (spec != pin["version"] or lock["packages"][""].get("devDependencies", {}).get(name) != spec
                or entry.get("version") != spec or entry.get("resolved") != expected_url
                or entry.get("integrity") != pin["integrity"]):
            raise ValueError(f"{name} does not match the reviewed lockfile pin")
        directory = root / "node_modules" / name
        if directory.is_symlink() or not directory.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"{name} is not a root-installed package")
        metadata = json.loads((directory / "package.json").read_text())
        if metadata.get("name") != name or metadata.get("version") != spec:
            raise ValueError(f"{name} installed identity differs")
        if package_tree_digest(directory) != pin["tree"]:
            raise ValueError(f"{name} installed package contents differ")
        binary = root / "node_modules/.bin" / pin["bin"]
        expected = (directory / pin["entry"]).resolve(strict=True)
        if binary.resolve(strict=True) != expected or not os.access(binary, os.X_OK):
            raise ValueError(f"{name} executable does not point to its reviewed package")


if __name__ == "__main__":
    try:
        verify_tools(sys.argv[1])
    except (OSError, ValueError, TypeError, KeyError, IndexError) as error:
        print(f"cve-lite gate: FAIL (tool verification: {error})", file=sys.stderr)
        raise SystemExit(1)
