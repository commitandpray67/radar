"""
CS2 Radar — desktop build script.

Usage (from repo root):
    python build.py              # build for the current OS
    python build.py --skip-fe    # skip frontend build (reuse existing dist/)
    python build.py --skip-py    # skip PyInstaller step (reuse existing bundle)
    python build.py --skip-fe --skip-py  # only run electron-builder

Outputs:
    frontend/dist/               React SPA
    backend/dist/radar-server/   PyInstaller bundle (~115 MB)
    electron/release/            platform installer (.exe / .dmg / .AppImage)
"""

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT     = Path(__file__).parent
FRONTEND = ROOT / "frontend"
BACKEND  = ROOT / "backend"
ELECTRON = ROOT / "electron"
SPEC     = ROOT / "radar_server.spec"

npm = "npm.cmd" if sys.platform == "win32" else "npm"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_tool(name: str) -> None:
    """Exit with a clear message if a required CLI tool is not on PATH."""
    cmd = [name, "--version"]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=10)
    except FileNotFoundError:
        _die(f"'{name}' not found. Install it and make sure it is on your PATH.")
    except subprocess.CalledProcessError:
        _die(f"'{name} --version' failed. Check your installation.")


def _die(msg: str) -> None:
    print(f"\n✗  {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd: list, cwd: Path = ROOT, timeout: int = 600) -> None:
    """Run a command, exit with a clear error if it fails or times out."""
    print(f"\n  $ {' '.join(str(c) for c in cmd)}")
    try:
        subprocess.check_call(cmd, cwd=str(cwd), timeout=timeout)
    except subprocess.TimeoutExpired:
        _die(f"Command timed out after {timeout}s:\n  {' '.join(str(c) for c in cmd)}")
    except subprocess.CalledProcessError as exc:
        _die(f"Command failed (exit {exc.returncode}):\n  {' '.join(str(c) for c in cmd)}")


# ---------------------------------------------------------------------------
# Build steps
# ---------------------------------------------------------------------------

def build_frontend() -> None:
    print("\n═══  1/3  Frontend (Vite)  ═══")

    lockfile = FRONTEND / "package-lock.json"
    run([npm, "ci" if lockfile.exists() else "install"], cwd=FRONTEND)
    run([npm, "run", "build"], cwd=FRONTEND)

    index = FRONTEND / "dist" / "index.html"
    if not index.exists():
        _die(f"Frontend build produced no index.html at {index}. Check Vite output above.")

    dist_size = sum(f.stat().st_size for f in (FRONTEND / "dist").rglob("*") if f.is_file())
    print(f"\n  → frontend/dist/  ({dist_size // 1000:,} kB)")


def build_backend() -> None:
    print("\n═══  2/3  Backend (PyInstaller)  ═══")

    launcher = BACKEND / "launcher.py"
    if not launcher.exists():
        _die(f"Backend entry point not found: {launcher}")

    dist_out = BACKEND / "dist"
    work_out = BACKEND / "build"
    shutil.rmtree(dist_out,  ignore_errors=True)
    shutil.rmtree(work_out,  ignore_errors=True)

    run(
        [
            sys.executable, "-m", "PyInstaller",
            "--clean", "--noconfirm",
            "--distpath", str(dist_out),
            "--workpath", str(work_out),
            str(SPEC),
        ],
        timeout=600,
    )

    bundle = dist_out / "radar-server"
    if not bundle.exists():
        _die(f"PyInstaller produced no bundle at {bundle}.")

    bundle_size = sum(f.stat().st_size for f in bundle.rglob("*") if f.is_file())
    print(f"\n  → backend/dist/radar-server/  ({bundle_size // 1_000_000} MB)")


def smoke_test_backend() -> None:
    """Start the bundled server and verify it responds to /api/health."""
    import http.client
    import os
    import signal

    exe_name = "radar-server.exe" if sys.platform == "win32" else "radar-server"
    exe = BACKEND / "dist" / "radar-server" / exe_name

    print("\n  Smoke-testing backend binary…")
    proc = subprocess.Popen(
        [str(exe)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    port = None
    deadline = time.monotonic() + 15
    for line in iter(proc.stdout.readline, ""):
        if line.startswith("PORT="):
            port = int(line.strip().split("=")[1])
            break
        if time.monotonic() > deadline:
            break

    if port is None:
        proc.kill()
        _die("Backend smoke test: process did not report PORT= within 15 s.")

    # Poll health endpoint
    healthy = False
    for _ in range(40):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            conn.request("GET", "/api/health")
            resp = conn.getresponse()
            resp.read()
            if resp.status == 200:
                healthy = True
                break
        except Exception:
            pass
        time.sleep(0.3)

    # Graceful shutdown
    if sys.platform == "win32":
        proc.terminate()
    else:
        proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=10)

    if not healthy:
        _die("Backend smoke test: /api/health did not return 200.")

    print("  ✓ Backend smoke test passed")


def build_electron() -> None:
    print("\n═══  3/3  Electron (electron-builder)  ═══")

    # Warn about missing icons before kicking off the slow electron-builder step.
    for icon_rel in ("build/icon.png",):
        if not (ELECTRON / icon_rel).exists():
            print(f"  WARNING: icon not found at electron/{icon_rel}. "
                  f"electron-builder may fail or use a default icon.")

    # Clean old release artefacts so stale installers don't confuse the user.
    shutil.rmtree(ELECTRON / "release", ignore_errors=True)

    lockfile = ELECTRON / "package-lock.json"
    run([npm, "ci" if lockfile.exists() else "install"], cwd=ELECTRON)
    run([npm, "run", "build"], cwd=ELECTRON, timeout=300)

    release_dir = ELECTRON / "release"
    print(f"\n  → electron/release/")
    for p in sorted(release_dir.rglob("*")):
        if p.is_file() and p.suffix in {".exe", ".dmg", ".AppImage", ".deb", ".rpm", ".snap"}:
            print(f"     {p.relative_to(ROOT)}  ({p.stat().st_size // 1_000_000} MB)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Build CS2 Radar desktop app")
    ap.add_argument("--skip-fe",       action="store_true", help="Skip frontend build")
    ap.add_argument("--skip-py",       action="store_true", help="Skip PyInstaller build")
    ap.add_argument("--skip-electron", action="store_true", help="Skip electron-builder")
    ap.add_argument("--no-smoke",      action="store_true", help="Skip backend smoke test")
    args = ap.parse_args()

    # Pre-flight checks
    _check_tool(npm)
    _check_tool("python3" if sys.platform != "win32" else "python")

    if not args.skip_fe:
        build_frontend()

    if not args.skip_py:
        build_backend()
        if not args.no_smoke:
            smoke_test_backend()

    if not args.skip_electron:
        build_electron()

    print("\n✓  Build complete. Installers are in electron/release/\n")


if __name__ == "__main__":
    main()
