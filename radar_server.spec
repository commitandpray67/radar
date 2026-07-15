# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the CS2 Radar backend bundle.
# Run from the repo root:
#   pyinstaller --clean --noconfirm \
#     --distpath backend/dist --workpath backend/build \
#     radar_server.spec

from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

hidden = [
    # uvicorn and its optional extras
    *collect_submodules("uvicorn"),
    # aiosqlite
    *collect_submodules("aiosqlite"),
    # demoparser2 (Rust extension — collect_submodules finds the .so/.pyd)
    *collect_submodules("demoparser2"),
    # Application modules (imported as strings by uvicorn.run / lifespan)
    "main",
    "api",
    *collect_submodules("api.routes"),   # now a package: health, maps, demos, heatmap, voice, teams, _shared
    "db", "db.database",
    "analytics", "analytics.coordinates", "analytics.heatmap", "analytics.team_detection",
    "maps", "maps.calibration",
    "parser",
    *collect_submodules("parser"),       # now a package: _types, _utils, _rounds, _positions, _grenades, _events
    "voice", "voice.extractor",
    # FACEIT integration (httpx) + compressed-demo support (zstandard)
    *collect_submodules("httpx"),
    *collect_submodules("zstandard"),
]

a = Analysis(
    ["backend/launcher.py"],
    pathex=["backend"],          # lets PyInstaller find main, api, db, … as top-level modules
    binaries=[],
    datas=[
        # Embed the built frontend so the server can serve it at runtime
        ("frontend/dist",        "frontend/dist"),
        ("frontend/public/maps", "frontend/public/maps"),
    ],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib", "matplotlib.tests",
        "scipy", "scipy.tests",
        "pandas", "pandas.tests",
        "numpy.tests",
        "pytest", "pytest_asyncio",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="radar-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Keep a console window so stdout (PORT=, LOGS_DIR=) is readable by Electron
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="radar-server",
)
