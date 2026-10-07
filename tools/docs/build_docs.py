#!/usr/bin/env python3
"""Build Brick Builder's record from its knowledge base and docs/record/ screenshots; publish locally.

    python3 tools/docs/build_docs.py [--publish]

The curated half (cover, pipeline, captioned galleries) is in
~/.claude/knowledge/projects/lego/08-record.md; the pictures come from tools/capture_record.mjs.
"""
from pathlib import Path
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
GALLERIES = []  # every gallery is listed in 08-record.md

if __name__ == "__main__":
    builder = runpy.run_path(str(Path.home() / ".local/bin/docs-build"))
    builder["build"](ROOT)
    if "--publish" in sys.argv:
        subprocess.run([str(Path.home() / ".local/bin/docs-site"), "publish"], check=True)
