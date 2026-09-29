from __future__ import annotations

import ctypes
import platform
from typing import Any, Protocol

from .policy import AgentPolicy, EventRateLimiter, validate_input_event


class InputBackend(Protocol):
    def apply(self, event: dict[str, Any]) -> None: ...


class WindowsInputBackend:
    """Small pynput adapter; imported lazily so protocol tests stay headless."""

    def __init__(self) -> None:
        if platform.system() != "Windows":
            raise RuntimeError("OS input injection is implemented only for Windows")
        from pynput import keyboard, mouse

        self.keyboard_module = keyboard
        self.mouse_module = mouse
        self.keyboard = keyboard.Controller()
        self.mouse = mouse.Controller()
        user32 = ctypes.windll.user32
        self.left = user32.GetSystemMetrics(76)
        self.top = user32.GetSystemMetrics(77)
        self.width = max(1, user32.GetSystemMetrics(78))
        self.height = max(1, user32.GetSystemMetrics(79))

    def apply(self, event: dict[str, Any]) -> None:
        kind = event["kind"]
        if kind == "mouse-move":
            self.mouse.position = (self.left + round(event["x"] * (self.width - 1)), self.top + round(event["y"] * (self.height - 1)))
            return
        if kind == "mouse-button":
            button = getattr(self.mouse_module.Button, event["button"])
            (self.mouse.press if event["pressed"] else self.mouse.release)(button)
            return
        key_name = event["key"]
        if len(key_name) == 1:
            key = key_name
        else:
            key = getattr(self.keyboard_module.Key, {"escape": "esc", "ctrl": "ctrl_l", "alt": "alt_l", "shift": "shift_l"}.get(key_name, key_name))
        (self.keyboard.press if event["pressed"] else self.keyboard.release)(key)


class InputController:
    def __init__(self, policy: AgentPolicy, backend: InputBackend | None = None) -> None:
        self.policy = policy
        self.backend = backend
        self.rate_limiter = EventRateLimiter(policy.max_events_per_second)

    @property
    def enabled(self) -> bool:
        return self.policy.allow_input

    def handle(self, event: Any) -> dict[str, Any]:
        if not self.enabled:
            raise PermissionError("remote input is disabled by host policy")
        normalized = validate_input_event(event)
        if not self.rate_limiter.accept():
            raise ValueError("input event rate limit exceeded")
        if self.backend is None:
            self.backend = WindowsInputBackend()
        self.backend.apply(normalized)
        return normalized
