from __future__ import annotations

import base64
import secrets
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

import aiohttp


@dataclass
class DeviceIdentity:
    token: str
    user_id: str
    device_id: str


class ControlClient:
    def __init__(self, base_url: str, *, token: str = "", enrollment_token: str = "", verify_tls: bool = True) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.enrollment_token = enrollment_token
        self.verify_tls = verify_tls
        self.session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> "ControlClient":
        connector = aiohttp.TCPConnector(ssl=self.verify_tls if self.base_url.startswith("https://") else False)
        self.session = aiohttp.ClientSession(connector=connector)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self.session is not None:
            await self.session.close()

    def _headers(self, *, include_enrollment: bool = False) -> dict[str, str]:
        headers = {"accept": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        if include_enrollment and self.enrollment_token:
            headers["x-enrollment-token"] = self.enrollment_token
        return headers

    async def request(self, method: str, path: str, *, body: dict | None = None, include_enrollment: bool = False) -> dict:
        if self.session is None:
            raise RuntimeError("ControlClient must be used as an async context manager")
        async with self.session.request(method, f"{self.base_url}{path}", json=body, headers=self._headers(include_enrollment=include_enrollment)) as response:
            payload = await response.json(content_type=None)
            if response.status >= 400:
                raise RuntimeError(payload.get("error", f"control API returned HTTP {response.status}"))
            return payload

    async def bootstrap(self, *, email: str, name: str, device_name: str, platform: str, device_id: str = "") -> DeviceIdentity:
        if not self.token:
            if not email:
                raise ValueError("--email is required when --token is not supplied")
            enrolled = await self.request("POST", "/api/v1/auth/enroll", body={"email": email, "name": name}, include_enrollment=True)
            self.token = enrolled["token"]
        if not device_id:
            public_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
            created = await self.request("POST", "/api/v1/devices", body={"name": device_name, "platform": platform, "publicKey": public_key})
            device_id = created["device"]["id"]
        me = await self.request("GET", "/api/v1/me")
        return DeviceIdentity(self.token, me["user"]["id"], device_id)

    async def issue_signal_ticket(self, session_id: str, device_id: str) -> str:
        payload = await self.request("POST", "/api/v1/signal-tickets", body={"sessionId": session_id, "deviceId": device_id})
        return str(payload["ticket"])

    async def ice_servers(self) -> list[dict]:
        payload = await self.request("GET", "/api/v1/config")
        return list(payload.get("iceServers", []))

    async def connect_signal(self, ticket: str) -> aiohttp.ClientWebSocketResponse:
        if self.session is None:
            raise RuntimeError("ControlClient is not open")
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        signal_url = urlunparse((scheme, parsed.netloc, "/signal", "", f"ticket={ticket}", ""))
        return await self.session.ws_connect(signal_url, heartbeat=20)
