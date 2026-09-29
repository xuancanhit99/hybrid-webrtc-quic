from __future__ import annotations

import argparse
import importlib.metadata as metadata
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    names = {"aiohttp", "aiortc", "av", "mss", "numpy", "pynput", "cryptography", "pyopenssl", "aioice", "cffi"}
    rows = ["# Installed package metadata", "", "| Distribution | Version | License |", "| --- | --- | --- |"]
    for distribution in sorted(metadata.distributions(), key=lambda item: item.metadata.get("Name", "").lower()):
        name = distribution.metadata.get("Name", "")
        if name.lower() not in names:
            continue
        license_name = distribution.metadata.get("License", "") or "(metadata did not declare one)"
        rows.append(f"| {name} | {distribution.version} | {license_name.replace('|', '/')} |")
    content = "\n".join(rows) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
