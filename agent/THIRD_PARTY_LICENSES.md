# Third-party runtime licenses

The packaged host agent includes or imports the following direct runtime packages. Versions are pinned in `requirements.lock`; transitive packages must be included in release review as reported by `scripts/license-report.py`.

| Package | Purpose | Upstream license (verify at build) |
| --- | --- | --- |
| aiohttp | HTTPS/WebSocket control client | Apache-2.0 |
| aiortc | WebRTC peer connection/media/data channels | BSD-3-Clause |
| av (PyAV) | Video frame conversion | BSD-3-Clause |
| mss | Desktop capture | MIT |
| numpy | Pixel array conversion | BSD-3-Clause |
| pynput | Opt-in Windows keyboard/mouse injection | LGPL-3.0-or-later |
| cryptography | TLS primitives used by dependencies | Apache-2.0 / BSD-3-Clause |

PyInstaller is a build tool, not linked application source; its bootloader is GPL-compatible with the PyInstaller exception. The control plane has no npm runtime dependencies beyond Node.js built-ins. coturn is an optional external service and retains its upstream license.

Run `python scripts/license-report.py --output release/THIRD_PARTY_METADATA.md` after installing the lock files. Do not ship a release until the generated metadata and any transitive license obligations have been reviewed.
