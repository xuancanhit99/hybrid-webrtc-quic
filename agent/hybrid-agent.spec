# PyInstaller build definition for the standalone Windows host agent.
from PyInstaller.utils.hooks import collect_data_files, collect_submodules


hiddenimports = []
for package in ("aiortc", "aioice", "av", "pyee", "pynput", "mss", "cryptography"):
    hiddenimports.extend(collect_submodules(package))

datas = []
for package in ("aiortc", "aioice", "av", "pynput", "mss"):
    datas.extend(collect_data_files(package))

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="HybridHostAgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
