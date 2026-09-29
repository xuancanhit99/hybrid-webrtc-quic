from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

from .capture import DesktopVideoTrack
from .client import ControlClient
from .config import config_from_args, parse_args
from .input_control import InputController
from .policy import AgentPolicy
from .protocol import FileReceiver, encode_file_messages

LOG = logging.getLogger("hybrid-agent")


def _candidate_to_json(candidate: Any) -> dict[str, Any] | None:
    if candidate is None:
        return None
    from aiortc.sdp import candidate_to_sdp

    value = candidate_to_sdp(candidate)
    return {"candidate": f"candidate:{value}", "sdpMid": getattr(candidate, "sdpMid", None), "sdpMLineIndex": getattr(candidate, "sdpMLineIndex", None)}


def _candidate_from_json(payload: dict[str, Any]) -> Any:
    from aiortc.sdp import candidate_from_sdp

    candidate = candidate_from_sdp(str(payload.get("candidate", "")).removeprefix("candidate:"))
    candidate.sdpMid = payload.get("sdpMid")
    candidate.sdpMLineIndex = payload.get("sdpMLineIndex")
    return candidate


class HostAgent:
    def __init__(self, config) -> None:
        self.config = config
        self.pc = None
        self.ws = None
        self.channel = None
        self.file_receiver = FileReceiver(max_bytes=config.policy.max_file_bytes)
        self.input_controller = InputController(config.policy)
        self.screen_track = None
        self._pending_candidates: list[dict[str, Any]] = []
        self._send_task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._closing = False

    async def run(self) -> None:
        from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription

        async with ControlClient(self.config.control_url, token=self.config.token, enrollment_token=self.config.enrollment_token, verify_tls=self.config.verify_tls) as control:
            identity = await control.bootstrap(email=self.config.email, name=self.config.user_name, device_name=self.config.device_name, platform=self.config.platform, device_id=self.config.device_id)
            ticket = await control.issue_signal_ticket(self.config.session_id, identity.device_id)
            ice_servers = [RTCIceServer(urls=entry["urls"], username=entry.get("username"), credential=entry.get("credential")) for entry in await control.ice_servers()]
            self.pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
            self._wire_peer(RTCSessionDescription)
            if self.config.policy.share_screen:
                self._ensure_screen_track()
            self.ws = await control.connect_signal(ticket)
            LOG.info("connected to signaling as %s", identity.device_id)
            try:
                await self._signal_loop(RTCSessionDescription)
            finally:
                await self._close_peer()

    def _wire_peer(self, session_description_type) -> None:
        @self.pc.on("icecandidate")
        async def on_ice(candidate) -> None:
            message = _candidate_to_json(candidate)
            if message and self.ws is not None:
                await self.ws.send_str(json.dumps({"type": "ice", "candidate": message}, separators=(",", ":")))

        @self.pc.on("datachannel")
        def on_datachannel(channel) -> None:
            self.channel = channel

            def announce_ready() -> None:
                if channel.readyState != "open":
                    return
                LOG.info("WebRTC data channel opened")
                channel.send(json.dumps({"type": "host-ready", "screen": self.config.policy.share_screen, "input": self.input_controller.enabled}, separators=(",", ":")))
                if self.config.send_file and self._send_task is None:
                    self._send_task = asyncio.create_task(self._send_file_after_open())

            @channel.on("open")
            def on_open() -> None:
                announce_ready()

            @channel.on("message")
            def on_message(message) -> None:
                asyncio.create_task(self._handle_data(message, session_description_type))

            if channel.readyState == "open":
                announce_ready()

        @self.pc.on("track")
        def on_track(track) -> None:
            LOG.info("received browser track kind=%s", track.kind)

    async def _signal_loop(self, session_description_type) -> None:
        assert self.ws is not None
        async for message in self.ws:
            if message.type.name == "TEXT":
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    LOG.warning("ignoring malformed signaling message")
                    continue
                await self._handle_signal(payload, session_description_type)
            elif message.type.name in {"CLOSE", "CLOSED", "ERROR"}:
                break

    async def _handle_signal(self, message: dict[str, Any], session_description_type) -> None:
        if not self.pc or not self.ws:
            return
        kind = message.get("type")
        if kind == "welcome":
            LOG.info("session role=%s peers=%s", message.get("role"), message.get("peers", []))
        elif kind == "offer":
            await self.pc.setRemoteDescription(session_description_type(sdp=message["sdp"]["sdp"], type=message["sdp"]["type"]))
            for candidate in self._pending_candidates:
                await self.pc.addIceCandidate(_candidate_from_json(candidate))
            self._pending_candidates.clear()
            answer = await self.pc.createAnswer()
            await self.pc.setLocalDescription(answer)
            await self.ws.send_str(json.dumps({"type": "answer", "sdp": {"type": self.pc.localDescription.type, "sdp": self.pc.localDescription.sdp}}, separators=(",", ":")))
        elif kind == "answer":
            await self.pc.setRemoteDescription(session_description_type(sdp=message["sdp"]["sdp"], type=message["sdp"]["type"]))
            for candidate in self._pending_candidates:
                await self.pc.addIceCandidate(_candidate_from_json(candidate))
            self._pending_candidates.clear()
        elif kind == "ice" and message.get("candidate"):
            if self.pc.remoteDescription:
                await self.pc.addIceCandidate(_candidate_from_json(message["candidate"]))
            else:
                self._pending_candidates.append(message["candidate"])

    async def _handle_data(self, message: Any, session_description_type) -> None:
        if isinstance(message, bytes):
            try:
                self.file_receiver.add_chunk(message)
            except ValueError as error:
                self._send_json({"type": "error", "code": "file_chunk", "message": str(error)})
            return
        try:
            payload = json.loads(message)
        except (TypeError, json.JSONDecodeError):
            self._send_json({"type": "error", "code": "invalid_message"})
            return
        kind = payload.get("type")
        try:
            if kind == "host-screen-start":
                if not self.config.policy.share_screen:
                    raise PermissionError("host screen sharing is disabled by policy")
                self.screen_track.activate()
                self._send_json({"type": "host-screen-ready", "enabled": self.screen_track is not None})
            elif kind == "input-capability-request":
                self._send_json({"type": "input-capability", "enabled": self.input_controller.enabled})
            elif kind == "input":
                event = self.input_controller.handle(payload.get("event"))
                self._send_json({"type": "input-ack", "event": event})
            elif kind == "file-start":
                manifest = self.file_receiver.start(payload)
                self._send_json({"type": "file-ack", "phase": "start", "name": manifest.name})
            elif kind == "file-complete":
                destination = self.config.download_dir / (self.file_receiver.manifest.name if self.file_receiver.manifest else "download.bin")
                saved = self.file_receiver.complete(payload, destination)
                self._send_json({"type": "file-ack", "phase": "complete", "path": str(saved)})
            elif kind == "ping":
                self._send_json({"type": "pong"})
            else:
                self._send_json({"type": "error", "code": "unsupported_command"})
        except (PermissionError, ValueError, RuntimeError) as error:
            LOG.warning("data command rejected: %s", error)
            self._send_json({"type": "error", "code": "command_rejected", "message": str(error)})

    async def _start_screen(self, session_description_type) -> None:
        if not self.config.policy.share_screen:
            raise PermissionError("host screen sharing is disabled by policy")
        self._ensure_screen_track()
        offer = await self.pc.createOffer()
        await self.pc.setLocalDescription(offer)
        await self.ws.send_str(json.dumps({"type": "offer", "sdp": {"type": self.pc.localDescription.type, "sdp": self.pc.localDescription.sdp}}, separators=(",", ":")))

    def _ensure_screen_track(self) -> None:
        if self.screen_track is None:
            self.screen_track = DesktopVideoTrack(monitor_index=self.config.monitor, fps=self.config.fps, max_width=self.config.max_width, active=self.config.policy.unattended)
            self.pc.addTrack(self.screen_track)

    async def _send_file_after_open(self) -> None:
        await asyncio.sleep(0.1)
        if not self.channel or not self.config.send_file:
            return
        try:
            for message in encode_file_messages(self.config.send_file, max_bytes=self.config.policy.max_file_bytes):
                self.channel.send(message)
                await asyncio.sleep(0)
                if isinstance(message, bytes):
                    while self.channel.bufferedAmount > 1024 * 1024:
                        await asyncio.sleep(0.02)
            LOG.info("sent file %s", self.config.send_file)
        except (OSError, ValueError) as error:
            LOG.error("file send failed: %s", error)

    def _send_json(self, payload: dict[str, Any]) -> None:
        if self.channel and self.channel.readyState == "open":
            self.channel.send(json.dumps(payload, separators=(",", ":")))

    async def _close_peer(self) -> None:
        if self._closing:
            return
        self._closing = True

        # Cancellation commonly arrives while the signaling loop is blocked in
        # aiohttp. Clear the pending cancellation long enough to let transports
        # close cleanly; otherwise aiortc can leave DTLS/ICE tasks behind.
        current = asyncio.current_task()
        cancellations = current.cancelling() if current is not None else 0
        if current is not None:
            for _ in range(cancellations):
                current.uncancel()
        try:
            if self.ws and not self.ws.closed:
                try:
                    await asyncio.wait_for(self.ws.close(), 5)
                except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError):
                    LOG.debug("signaling websocket did not close cleanly", exc_info=True)
            if self._send_task:
                self._send_task.cancel()
                await asyncio.gather(self._send_task, return_exceptions=True)
            if self.screen_track:
                self.screen_track.stop()
            if self.pc:
                try:
                    await asyncio.wait_for(self.pc.close(), 5)
                except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError):
                    LOG.debug("peer connection did not close cleanly", exc_info=True)
        finally:
            # Do not re-issue cancellation here: callers already receive a
            # completed shutdown, and this avoids a second CancelledError while
            # the event loop is draining aiortc callbacks.
            self._stopped.set()

    async def stop(self) -> None:
        if self.ws and not self.ws.closed:
            await self.ws.close()


def dependency_self_test() -> int:
    modules = ["aiohttp", "aiortc", "av", "mss", "numpy", "pynput"]
    failures = []
    for module in modules:
        try:
            __import__(module)
            print(f"{module}: ok")
        except Exception as error:  # pragma: no cover - platform-specific import diagnostics
            print(f"{module}: unavailable ({error})")
            failures.append(module)
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    import argparse
    try:
        args = parse_args(argv)
    except ValueError as error:
        # Keep config-file errors in argparse's familiar CLI format.
        argparse.ArgumentParser(prog="HybridHostAgent").error(str(error))
    if args.self_test_dependencies:
        return dependency_self_test()
    try:
        config = config_from_args(args)
    except ValueError as error:
        argparse.ArgumentParser(prog="HybridHostAgent").error(str(error))
    try:
        asyncio.run(HostAgent(config).run())
    except KeyboardInterrupt:
        return 130
    except Exception:
        LOG.exception("host agent stopped")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
