#!/usr/bin/env python3
"""Preserve the capability-algebra seed corpus in one reviewable file."""

import argparse
import base64
import binascii
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import zipfile

MAX_BUNDLE_BYTES = 2 * 1024 * 1024
MAX_SEED_BYTES = 1024 * 1024
MAX_SEEDS = 10_000
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate JSON key: {key}")
        obj[key] = value
    return obj


def valid_name(name):
    return isinstance(name, str) and NAME.fullmatch(name) is not None


def validate_seeds(seeds):
    if not seeds or len(seeds) > MAX_SEEDS:
        raise ValueError("invalid number of seeds")
    if sum(len(value) for value in seeds.values()) > MAX_SEED_BYTES:
        raise ValueError("seed corpus exceeds the size limit")
    for name, value in seeds.items():
        if not valid_name(name) or len(value) > MAX_SEED_BYTES:
            raise ValueError(f"invalid seed name or size: {name!r}")
    return seeds


def read_bundle(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BUNDLE_BYTES:
        raise ValueError("bundle must be a regular file within the size limit")
    bundle = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if (not isinstance(bundle, dict) or set(bundle) != {"version", "seeds"}
            or type(bundle["version"]) is not int or bundle["version"] != 1
            or not isinstance(bundle["seeds"], dict)):
        raise ValueError("invalid seed bundle structure")
    seeds = {}
    for name, value in bundle["seeds"].items():
        if not valid_name(name) or not isinstance(value, str):
            raise ValueError("invalid seed entry")
        try:
            seeds[name] = base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError(f"invalid base64 seed: {name}") from error
    return validate_seeds(seeds)


def read_directory(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError("seed source must be a directory, not a symlink")
    seeds = {}
    for entry in path.iterdir():
        if not valid_name(entry.name) or entry.is_symlink() or not entry.is_file():
            raise ValueError(f"seed must be a named regular file: {entry.name}")
        if entry.stat().st_size > MAX_SEED_BYTES:
            raise ValueError(f"seed is too large: {entry.name}")
        seeds[entry.name] = entry.read_bytes()
    return validate_seeds(seeds)


def read_loose_tree(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError("loose corpus must be a directory, not a symlink")
    seeds = {}
    total = 0
    def fail_walk(error):
        raise error

    for parent, directories, files in os.walk(path, followlinks=False, onerror=fail_walk):
        directory = Path(parent)
        if any((directory / name).is_symlink() for name in directories):
            raise ValueError("loose corpus contains a directory symlink")
        for name in files:
            entry = directory / name
            relative = entry.relative_to(path).as_posix()
            if (entry.is_symlink() or not entry.is_file() or "\\" in relative or ":" in relative
                    or len(relative) > 1024 or entry.stat().st_size > MAX_SEED_BYTES):
                raise ValueError(f"invalid loose seed: {relative!r}")
            seeds[relative] = entry.read_bytes()
            total += len(seeds[relative])
            if len(seeds) > MAX_SEEDS or total > MAX_SEED_BYTES:
                raise ValueError("loose corpus exceeds the size limit")
    return seeds


def write_bundle(path, seeds):
    values = {name: base64.b64encode(value).decode("ascii")
              for name, value in sorted(validate_seeds(seeds).items())}
    content = json.dumps({"version": 1, "seeds": values}, indent=2, sort_keys=True) + "\n"
    if len(content.encode("utf-8")) > MAX_BUNDLE_BYTES:
        raise ValueError("encoded bundle exceeds the size limit")
    # A maintainer must explicitly review and replace the tracked bundle.
    with path.open("x", encoding="utf-8", newline="\n") as output:
        output.write(content)


def materialize(seeds, destination):
    # Never clear or write into a developer's existing corpus directory.
    destination.mkdir(mode=0o700)
    for name, value in sorted(seeds.items()):
        with (destination / name).open("xb") as output:
            output.write(value)


def zip_corpus(seeds, loose_directory, destination):
    if loose_directory.exists() or loose_directory.is_symlink():
        for name, value in read_loose_tree(loose_directory).items():
            if name in seeds and seeds[name] != value:
                raise ValueError(f"loose seed conflicts with bundled seed: {name}")
            seeds[name] = value
    if len(seeds) > MAX_SEEDS or sum(map(len, seeds.values())) > MAX_SEED_BYTES:
        raise ValueError("merged corpus exceeds the size limit")
    fd, temporary = tempfile.mkstemp(prefix=".capability-corpus-", dir=destination.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED,
                             compresslevel=9) as archive:
            for name, value in sorted(seeds.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, value, compresslevel=9)
        # Match zip's umask-respecting output, without widening an existing file.
        mask = os.umask(0o777)
        os.umask(mask)
        mode = 0o666 & ~mask
        if destination.is_file() and not destination.is_symlink():
            mode &= stat.S_IMODE(destination.stat().st_mode)
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("pack", "materialize"):
        sub = commands.add_parser(command)
        sub.add_argument("source", type=Path)
        sub.add_argument("destination", type=Path)
    sub = commands.add_parser("zip")
    sub.add_argument("bundle", type=Path)
    sub.add_argument("loose_directory", type=Path)
    sub.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.command == "pack":
        write_bundle(args.destination, read_directory(args.source))
    elif args.command == "materialize":
        materialize(read_bundle(args.source), args.destination)
    else:
        zip_corpus(read_bundle(args.bundle), args.loose_directory, args.destination)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, UnicodeError) as error:
        print(f"capability corpus: {error}", file=sys.stderr)
        sys.exit(1)
