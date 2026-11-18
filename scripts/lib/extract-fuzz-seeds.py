#!/usr/bin/env python3
"""Extract flat, regular fuzz seed archives without trusting archive paths."""
import re
import stat
import sys
from pathlib import Path
from zipfile import ZipFile

archive, destination = map(Path, sys.argv[1:])
with ZipFile(archive) as seeds:
    entries = seeds.infolist()
    names = [entry.filename for entry in entries]
    if len(names) != len(set(names)) or not entries:
        raise ValueError("empty archive or duplicate seed names")
    for entry in entries:
        mode = entry.external_attr >> 16
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", entry.filename)
                or not stat.S_ISREG(mode) or entry.file_size > 2 * 1024 * 1024):
            raise ValueError(f"invalid seed archive entry: {entry.filename!r}")
    destination.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        with (destination / entry.filename).open("xb") as output:
            output.write(seeds.read(entry))
