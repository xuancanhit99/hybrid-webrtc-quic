from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .policy import AgentPolicy


CONFIG_KEYS = frozenset({
    "control_url", "token", "device_id", "session_id", "email", "user_name", "device_name",
    "platform", "enrollment_token", "download_dir", "send_file", "share_screen", "allow_input",
    "unattended", "consent_file", "max_file_mb", "monitor", "fps", "max_width", "insecure_http",
})


@dataclass(frozen=True)
class AgentConfig:
    control_url: str
    token: str
    device_id: str
    session_id: str
    email: str
    user_name: str
    device_name: str
    platform: str
    enrollment_token: str
    download_dir: Path
    send_file: Path | None
    policy: AgentPolicy
    monitor: int = 1
    fps: int = 15
    max_width: int = 1920
    verify_tls: bool = True

    def validate(self) -> None:
        parsed = urlparse(self.control_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("control URL must be an absolute http(s) URL")
        if not self.session_id.startswith("ses_"):
            raise ValueError("session ID must start with ses_")
        if self.send_file is not None and not self.send_file.is_file():
            raise ValueError(f"send file does not exist: {self.send_file}")
        if self.monitor < 0 or not 1 <= self.fps <= 60 or not 320 <= self.max_width <= 7680:
            raise ValueError("monitor/fps/max-width values are outside supported bounds")
        self.policy.validate()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hybrid WebRTC Windows host agent")
    parser.add_argument("--control-url", default=os.getenv("HYBRID_CONTROL_URL", "http://127.0.0.1:8787"))
    parser.add_argument("--token", default=os.getenv("HYBRID_TOKEN", ""))
    parser.add_argument("--device-id", default=os.getenv("HYBRID_DEVICE_ID", ""))
    parser.add_argument("--session-id", default=os.getenv("HYBRID_SESSION_ID", ""))
    parser.add_argument("--email", default=os.getenv("HYBRID_EMAIL", ""))
    parser.add_argument("--name", dest="user_name", default=os.getenv("HYBRID_USER_NAME", "Windows host operator"))
    parser.add_argument("--device-name", default=os.getenv("HYBRID_DEVICE_NAME", "Windows host"))
    parser.add_argument("--platform", default="windows-agent")
    parser.add_argument("--enrollment-token", default=os.getenv("ENROLLMENT_TOKEN", ""))
    parser.add_argument("--download-dir", type=Path, default=Path(os.getenv("HYBRID_DOWNLOAD_DIR", "RemoteInbox")))
    parser.add_argument("--send-file", type=Path, default=Path(os.environ["HYBRID_SEND_FILE"]) if os.getenv("HYBRID_SEND_FILE") else None)
    parser.add_argument("--share-screen", action="store_true", help="allow the browser to request desktop video")
    parser.add_argument("--allow-input", action="store_true", help="opt into remote keyboard/mouse events")
    parser.add_argument("--unattended", action="store_true", help="allow unattended input only with explicit consent file")
    parser.add_argument("--consent-file", type=Path, default=Path(os.environ["HYBRID_CONSENT_FILE"]) if os.getenv("HYBRID_CONSENT_FILE") else None)
    parser.add_argument("--max-file-mb", type=int, default=int(os.getenv("HYBRID_MAX_FILE_MB", "8")))
    parser.add_argument("--monitor", type=int, default=int(os.getenv("HYBRID_MONITOR", "1")))
    parser.add_argument("--fps", type=int, default=int(os.getenv("HYBRID_FPS", "15")))
    parser.add_argument("--max-width", type=int, default=int(os.getenv("HYBRID_MAX_WIDTH", "1920")))
    parser.add_argument("--insecure-http", action="store_true", help="allow HTTP control URL for local development")
    parser.add_argument("--self-test-dependencies", action="store_true", help="import optional runtime modules and exit")
    parser.add_argument("--config", type=Path, default=None, help="JSON config path; command-line options override it")
    return parser


def load_config_file(path: Path) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"cannot read config file: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"config file is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError("config file must contain a JSON object")
    unknown = sorted(set(value) - CONFIG_KEYS)
    if unknown:
        raise ValueError(f"unknown config key(s): {', '.join(unknown)}")
    return value


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    probe = argparse.ArgumentParser(add_help=False)
    probe.add_argument("--config", type=Path, default=None)
    probe_args, _ = probe.parse_known_args(argv)
    defaults = load_config_file(probe_args.config) if probe_args.config else {}
    parser = build_parser()
    parser.set_defaults(**defaults)
    return parser.parse_args(argv)


def config_from_args(args: argparse.Namespace) -> AgentConfig:
    if args.max_file_mb < 1 or args.max_file_mb > 1024:
        raise ValueError("--max-file-mb must be between 1 and 1024")
    policy = AgentPolicy(
        share_screen=bool(args.share_screen),
        allow_input=bool(args.allow_input),
        unattended=bool(args.unattended),
        consent_file=args.consent_file,
        max_file_bytes=args.max_file_mb * 1024 * 1024,
    )
    config = AgentConfig(
        control_url=args.control_url.rstrip("/"), token=args.token, device_id=args.device_id,
        session_id=args.session_id, email=args.email, user_name=args.user_name,
        device_name=args.device_name, platform=args.platform, enrollment_token=args.enrollment_token,
        download_dir=Path(args.download_dir), send_file=Path(args.send_file) if args.send_file else None, policy=policy,
        monitor=args.monitor, fps=args.fps, max_width=args.max_width,
        verify_tls=not args.insecure_http,
    )
    config.validate()
    if config.control_url.startswith("http://") and config.verify_tls:
        # Local HTTP is acceptable for development but must be explicit in production deployment scripts.
        raise ValueError("HTTP control URL requires --insecure-http")
    return config
