from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONSENT_PHRASE = "I_UNDERSTAND_REMOTE_INPUT"
ALLOWED_KEYS = frozenset(
    [*"abcdefghijklmnopqrstuvwxyz0123456789"]
    + ["enter", "tab", "escape", "backspace", "delete", "space", "up", "down", "left", "right", "shift", "ctrl", "alt"]
)
ALLOWED_MOUSE_BUTTONS = frozenset(["left", "right", "middle"])


def validate_consent_file(path: Path | None) -> bool:
    if path is None:
        return False
    try:
        return Path(path).read_text(encoding="utf-8").strip() == CONSENT_PHRASE
    except OSError:
        return False


@dataclass(frozen=True)
class AgentPolicy:
    share_screen: bool = False
    allow_input: bool = False
    unattended: bool = False
    consent_file: Path | None = None
    max_file_bytes: int = 8 * 1024 * 1024
    max_events_per_second: int = 120

    def validate(self) -> None:
        if self.max_file_bytes <= 0 or self.max_file_bytes > 1024 * 1024 * 1024:
            raise ValueError("max_file_bytes must be between 1 byte and 1 GiB")
        if self.max_events_per_second < 1 or self.max_events_per_second > 500:
            raise ValueError("max_events_per_second must be between 1 and 500")
        if self.allow_input and not validate_consent_file(self.consent_file):
            raise ValueError(f"--allow-input requires a consent file containing exactly {CONSENT_PHRASE}")
        if self.unattended and not (self.share_screen and self.allow_input and validate_consent_file(self.consent_file)):
            raise ValueError("--unattended requires --share-screen, --allow-input and a valid consent file")


class EventRateLimiter:
    def __init__(self, maximum: int, clock=time.monotonic) -> None:
        self.maximum = maximum
        self.clock = clock
        self._events: deque[float] = deque()

    def accept(self) -> bool:
        now = self.clock()
        while self._events and self._events[0] <= now - 1:
            self._events.popleft()
        if len(self._events) >= self.maximum:
            return False
        self._events.append(now)
        return True


def validate_input_event(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise ValueError("input event must be an object")
    kind = event.get("kind")
    if kind == "mouse-move":
        x, y = event.get("x"), event.get("y")
        if not isinstance(x, (int, float)) or isinstance(x, bool) or not 0 <= x <= 1:
            raise ValueError("mouse x must be normalized between 0 and 1")
        if not isinstance(y, (int, float)) or isinstance(y, bool) or not 0 <= y <= 1:
            raise ValueError("mouse y must be normalized between 0 and 1")
        return {"kind": kind, "x": float(x), "y": float(y)}
    if kind == "mouse-button":
        button, pressed = event.get("button"), event.get("pressed")
        if button not in ALLOWED_MOUSE_BUTTONS or not isinstance(pressed, bool):
            raise ValueError("invalid mouse button event")
        return {"kind": kind, "button": button, "pressed": pressed}
    if kind == "key":
        key, pressed = str(event.get("key", "")).lower(), event.get("pressed")
        if key not in ALLOWED_KEYS or not isinstance(pressed, bool):
            raise ValueError("key is not allowed")
        return {"kind": kind, "key": key, "pressed": pressed}
    raise ValueError("unsupported input event")
