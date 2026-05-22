"""
CS2 Radar — desktop build script.

Usage (from repo root):
    python build.py              # build for current OS
    python build.py --skip-fe    # skip frontend build (uses existing dist/)
    python build.py --skip-py    # skip PyInstaller step (uses existing bundle)
    python build.py --skip-fe --skip-py  # only run electron-builder

Outputs:
    frontend/dist/               React SPA
    backend/dist/radar-server/   PyInstaller bundle
    electron/release/            installer (.exe / .dmg / .AppImage)
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
FRONTEND = ROOT / "frontend"
BACKEND = ROOT / "backend"
ELECTRON = ROOT / "electron"
SPEC = ROOT / "radar_server.spec"

npm = "npm.cmd" if sys.platform == "win32" else "npm"


def run(cmd: list, cwd: Path = ROOT, **kw) -> None:
    print(f"\n>>> {' '.join(str(c) for c in cmd)}  (cwd={cwd})")
    subprocess.check_call(cmd, cwd=str(cwd), **kw)


def build_frontend() -> None:
    print("\n=== 1/3  Frontend (Vite) ===")
    run([npm, "ci"], cwd=FRONTEND)
    run([npm, "run", "build"], cwd=FRONTEND)
    dist = FRONTEND / "dist"
    assert dist.exists(), f"Frontend build produced no dist/ at {dist}"
    print(f"    → {dist}")


def build_backend() -> None:
    print("\n=== 2/3  Backend (PyInstaller) ===")
    dist_out = BACKEND / "dist"
    work_out = BACKEND / "build"
    shutil.rmtree(dist_out, ignore_errors=True)
    shutil.rmtree(work_out, ignore_errors=True)
    run(
        [
            sys.executable, "-m", "PyInstaller",
            "--clean", "--noconfirm",
            "--distpath", str(dist_out),
            "--workpath", str(work_out),
            str(SPEC),
        ]
    )
    bundle = dist_out / "radar-server"
    assert bundle.exists(), f"PyInstaller produced no bundle at {bundle}"
    print(f"    → {bundle}")


def build_electron() -> None:
    print("\n=== 3/3  Electron (electron-builder) ===")
    run([npm, "ci"], cwd=ELECTRON)
    run([npm, "run", "build"], cwd=ELECTRON)
    release = ELECTRON / "release"
    print(f"    → {release}")
    for p in sorted(release.rglob("*")):
        if p.is_file() and p.suffix in {".exe", ".dmg", ".AppImage", ".deb", ".rpm", ".snap"}:
            size_mb = p.stat().st_size / 1_000_000
            print(f"       {p.relative_to(ROOT)}  ({size_mb:.0f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build CS2 Radar desktop app")
    ap.add_argument("--skip-fe",  action="store_true", help="Skip frontend build")
    ap.add_argument("--skip-py",  action="store_true", help="Skip PyInstaller build")
    ap.add_argument("--skip-electron", action="store_true", help="Skip electron-builder")
    args = ap.parse_args()

    if not args.skip_fe:
        build_frontend()
    if not args.skip_py:
        build_backend()
    if not args.skip_electron:
        build_electron()

    print("\n✓  Build complete. Installers are in electron/release/")


if __name__ == "__main__":
    main()
