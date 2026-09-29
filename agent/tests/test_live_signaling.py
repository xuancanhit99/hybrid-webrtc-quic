import asyncio
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import aiohttp
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from aiortc.sdp import candidate_from_sdp
except ImportError:  # pragma: no cover - optional integration dependency
    aiohttp = None

from hybrid_agent.agent import HostAgent
from hybrid_agent.config import AgentConfig
from hybrid_agent.policy import AgentPolicy
from hybrid_agent.protocol import FileReceiver, encode_browser_chunk, sha256_hex


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@unittest.skipIf(aiohttp is None, "aiortc/aiohttp integration dependencies are not installed")
class LiveSignalingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 1.0
        self.product_root = Path(__file__).resolve().parents[2]
        self.port = free_port()
        env = os.environ.copy()
        env.update({"HOST": "127.0.0.1", "PORT": str(self.port), "PUBLIC_ORIGIN": f"http://127.0.0.1:{self.port}", "SESSION_SECRET": "integration-secret-" + "x" * 40})
        self.server = await asyncio.create_subprocess_exec("node", "src/server.mjs", cwd=self.product_root, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        async with aiohttp.ClientSession() as session:
            for _ in range(100):
                try:
                    async with session.get(f"http://127.0.0.1:{self.port}/healthz") as response:
                        if response.status == 200:
                            return
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.05)
        output = (await self.server.stdout.read()).decode(errors="replace")
        self.fail(f"Node server did not start: {output}")

    async def asyncTearDown(self):
        if self.server.returncode is None:
            self.server.terminate()
            try:
                await asyncio.wait_for(self.server.wait(), 5)
            except asyncio.TimeoutError:
                self.server.kill()
                await self.server.wait()

    async def test_real_node_signaling_and_agent_datachannel(self):
        origin = f"http://127.0.0.1:{self.port}"
        async with aiohttp.ClientSession() as http:
            async def request(method, path, body=None, token=""):
                headers = {"authorization": f"Bearer {token}"} if token else {}
                async with http.request(method, origin + path, json=body, headers=headers) as response:
                    payload = await response.json()
                    self.assertLess(response.status, 400, payload)
                    return payload

            enrolled = await request("POST", "/api/v1/auth/enroll", {"email": "agent-live@example.test", "name": "Live"})
            token = enrolled["token"]
            source = (await request("POST", "/api/v1/devices", {"name": "Controller", "platform": "test"}, token))["device"]
            target = (await request("POST", "/api/v1/devices", {"name": "Host", "platform": "windows-agent"}, token))["device"]
            session = (await request("POST", "/api/v1/sessions", {"sourceDeviceId": source["id"], "targetDeviceId": target["id"]}, token))["session"]
            source_ticket = (await request("POST", "/api/v1/signal-tickets", {"sessionId": session["id"], "deviceId": source["id"]}, token))["ticket"]

        with tempfile.TemporaryDirectory() as directory:
            config = AgentConfig(
                control_url=origin, token=token, device_id=target["id"], session_id=session["id"],
                email="", user_name="Live", device_name="Host", platform="windows-agent", enrollment_token="",
                download_dir=Path(directory), send_file=Path(directory) / "host-send.txt", policy=AgentPolicy(share_screen=True), verify_tls=False,
            )
            config.send_file.write_bytes(b"file sent by native host")
            agent = HostAgent(config)
            agent_task = asyncio.create_task(agent.run())
            browser_pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            browser_pc.addTransceiver("video", direction="recvonly")
            channel = browser_pc.createDataChannel("control", ordered=True)
            channel_open = asyncio.Event()
            messages = asyncio.Queue()
            tracks = asyncio.Queue()

            @channel.on("open")
            def on_open():
                channel_open.set()

            @channel.on("message")
            def on_message(message):
                messages.put_nowait(json.loads(message) if isinstance(message, str) else message)

            @browser_pc.on("track")
            def on_track(track):
                tracks.put_nowait(track)

            ws = None
            remote_track = None
            try:
                await asyncio.sleep(0.1)
                async with aiohttp.ClientSession() as browser_http:
                    ws = await browser_http.ws_connect(f"ws://127.0.0.1:{self.port}/signal?ticket={source_ticket}")
                    @browser_pc.on("icecandidate")
                    async def on_browser_ice(candidate):
                        if candidate is not None:
                            from aiortc.sdp import candidate_to_sdp
                            await ws.send_json({"type": "ice", "candidate": {"candidate": f"candidate:{candidate_to_sdp(candidate)}", "sdpMid": candidate.sdpMid, "sdpMLineIndex": candidate.sdpMLineIndex}})
                    offer = await browser_pc.createOffer()
                    await browser_pc.setLocalDescription(offer)
                    await ws.send_json({"type": "offer", "sdp": {"type": browser_pc.localDescription.type, "sdp": browser_pc.localDescription.sdp}})
                    async for signal in ws:
                        if signal.type == aiohttp.WSMsgType.TEXT:
                            payload = json.loads(signal.data)
                            if payload.get("type") == "answer":
                                await browser_pc.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"]["sdp"], type=payload["sdp"]["type"]))
                            elif payload.get("type") == "ice" and payload.get("candidate"):
                                candidate = candidate_from_sdp(payload["candidate"]["candidate"].removeprefix("candidate:"))
                                candidate.sdpMid = payload["candidate"].get("sdpMid")
                                candidate.sdpMLineIndex = payload["candidate"].get("sdpMLineIndex")
                                await browser_pc.addIceCandidate(candidate)
                            if payload.get("type") == "answer":
                                break
                    await asyncio.wait_for(channel_open.wait(), 10)
                    ready = await asyncio.wait_for(messages.get(), 5)
                    self.assertEqual(ready["type"], "host-ready")
                    self.assertTrue(ready["screen"])
                    sent_receiver = FileReceiver(max_bytes=1024)
                    sent_complete = False
                    while not sent_complete:
                        outgoing = await asyncio.wait_for(messages.get(), 5)
                        if isinstance(outgoing, bytes):
                            sent_receiver.add_chunk(outgoing)
                        elif outgoing.get("type") == "file-start":
                            sent_receiver.start(outgoing)
                        elif outgoing.get("type") == "file-complete":
                            self.assertEqual(sent_receiver.complete(outgoing), b"file sent by native host")
                            sent_complete = True
                    channel.send(json.dumps({"type": "input-capability-request"}))
                    capability = await asyncio.wait_for(messages.get(), 5)
                    self.assertEqual(capability, {"type": "input-capability", "enabled": False})
                    channel.send(json.dumps({"type": "host-screen-start"}))
                    ready_message = await asyncio.wait_for(messages.get(), 5)
                    self.assertEqual(ready_message["type"], "host-screen-ready")
                    remote_track = await asyncio.wait_for(tracks.get(), 10)
                    frame = await asyncio.wait_for(remote_track.recv(), 10)
                    self.assertGreater(frame.width, 0)
                    self.assertGreater(frame.height, 0)
                    file_data = b"live WebRTC file transfer"
                    channel.send(json.dumps({"type": "file-start", "name": "live.txt", "size": len(file_data), "sha256": sha256_hex(file_data)}))
                    channel.send(encode_browser_chunk(0, file_data))
                    channel.send(json.dumps({"type": "file-complete"}))
                    start_ack = await asyncio.wait_for(messages.get(), 5)
                    complete_ack = await asyncio.wait_for(messages.get(), 5)
                    self.assertEqual(start_ack["phase"], "start")
                    self.assertEqual(Path(complete_ack["path"]).read_bytes(), file_data)
                    await ws.close()
            finally:
                if ws is not None and not ws.closed:
                    await ws.close()
                if remote_track is not None:
                    remote_track.stop()
                await agent.stop()
                try:
                    await asyncio.wait_for(agent_task, 10)
                except asyncio.TimeoutError:
                    agent_task.cancel()
                    await asyncio.gather(agent_task, return_exceptions=True)
                await asyncio.wait_for(browser_pc.close(), 10)


if __name__ == "__main__":
    unittest.main()
