#!/usr/bin/env python3
"""Treat renderer output as data, never as scripts or Git configuration."""
import os
import pathlib
import re
import stat
import sys

FILES = ("star-history-light.svg", "star-history-dark.svg", "star-history.png", ".star-history.sig")
MAX_BYTES = 10 * 1024 * 1024


def stage(source: pathlib.Path, destination: pathlib.Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Chart artifact must be a directory")
    if {p.name for p in source.iterdir()} != set(FILES):
        raise ValueError("Chart artifact contains missing or unexpected files")
    payloads = {}
    for name in FILES:
        fd = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES:
                raise ValueError(f"Invalid chart file: {name}")
            data = file.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError(f"Chart file exceeds limit: {name}")
        if name.endswith(".svg") and not data.lstrip().startswith(b"<svg"):
            raise ValueError(f"Invalid SVG: {name}")
        if name.endswith(".png") and not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Invalid chart PNG")
        if name.endswith(".sig") and not re.fullmatch(rb"[a-f0-9]{64}\n?", data):
            raise ValueError("Invalid chart signature")
        payloads[name] = data
    # Validate everything before writing anything into the publishing repository.
    for name, data in payloads.items():
        with (destination / name).open("xb") as file:
            file.write(data)


if __name__ == "__main__":
    stage(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
