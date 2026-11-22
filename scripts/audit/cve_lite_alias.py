"""Validate a local npm $alias against its locked, content-addressed tarball."""
import base64
import hashlib
import io
import json
import tarfile


def verified_alias(root, manifest, lock, alias, name):
    dependencies = [manifest.get(section, {}).get(alias) for section in
                    ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")]
    try:
        specs = {spec for spec in dependencies if spec is not None}
        if len(specs) != 1:
            return None
        spec = specs.pop()
        if not isinstance(spec, str) or not spec.startswith("file:"):
            return None
        archive = (root / spec[5:]).resolve(strict=True)
        if not archive.is_relative_to(root) or not archive.is_file():
            return None
        data = archive.read_bytes()
        entry = lock["packages"][f"node_modules/{alias}"]
        digest = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
        if entry.get("resolved") != spec or entry.get("integrity") != digest:
            return None
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            metadata = json.load(tar.extractfile("package/package.json"))
        if metadata.get("name") != name or metadata.get("version") != entry.get("version"):
            return None
        return {"spec": spec, "integrity": digest, "version": metadata["version"]}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError):
        return None
