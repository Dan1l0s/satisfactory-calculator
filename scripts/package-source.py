#!/usr/bin/env python3
"""Package the standalone repository"""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "dist" / "factory-lens-source.zip"
EXCLUDED = {".git", "node_modules", "__pycache__", ".cache", "tmp", "temp", "archives", ".pytest_cache"}
FILES = (
    "README.md", "LICENSE", "NOTICE.txt",
    "package.json", ".gitignore", ".gitattributes", ".editorconfig", ".prettierrc.json",
)

def main():
    candidates = [ROOT / name for name in FILES]
    for name in ("dist", "scripts", "tests", ".github"):
        candidates.extend((ROOT / name).rglob("*"))
    with ZipFile(DEST, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(set(candidates)):
            relative = path.relative_to(ROOT)
            if path.is_symlink() or not path.is_file() or path == DEST or any(part in EXCLUDED for part in relative.parts):
                continue
            if path.name.startswith(".env") or path.suffix in (".pyc", ".zip", ".tar", ".gz", ".log"):
                continue
            archive.write(path, str(Path("factory-lens") / relative))
    print(f"Created {DEST.name}: {DEST.stat().st_size:,} bytes")

if __name__ == "__main__":
    main()
