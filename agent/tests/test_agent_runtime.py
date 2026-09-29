import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from hybrid_agent.agent import HostAgent
from hybrid_agent.policy import AgentPolicy, CONSENT_PHRASE
from hybrid_agent.protocol import encode_browser_chunk, sha256_hex


class FakeChannel:
    readyState = "open"

    def __init__(self):
        self.sent = []
        self.bufferedAmount = 0

    def send(self, value):
        self.sent.append(value)


class FakeBackend:
    def __init__(self):
        self.events = []

    def apply(self, event):
        self.events.append(event)


class AgentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_data_channel_ping_file_and_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            consent = root / "consent.txt"
            consent.write_text(CONSENT_PHRASE, encoding="utf-8")
            config = SimpleNamespace(
                policy=AgentPolicy(allow_input=True, consent_file=consent, max_file_bytes=1024),
                download_dir=root / "downloads",
                send_file=None,
                monitor=1,
                fps=15,
                max_width=1920,
            )
            agent = HostAgent(config)
            agent.channel = FakeChannel()
            backend = FakeBackend()
            agent.input_controller.backend = backend

            await agent._handle_data(json.dumps({"type": "ping"}), None)
            self.assertEqual(json.loads(agent.channel.sent[-1])["type"], "pong")

            data = b"agent-file"
            await agent._handle_data(json.dumps({"type": "file-start", "name": "../a.txt", "size": len(data), "sha256": sha256_hex(data)}), None)
            await agent._handle_data(encode_browser_chunk(0, data), None)
            await agent._handle_data(json.dumps({"type": "file-complete"}), None)
            saved = Path(json.loads(agent.channel.sent[-1])["path"])
            self.assertEqual(saved.parent, root / "downloads")
            self.assertEqual(saved.read_bytes(), data)

            await agent._handle_data(json.dumps({"type": "input", "event": {"kind": "mouse-move", "x": 0.2, "y": 0.8}}), None)
            self.assertEqual(backend.events[-1]["kind"], "mouse-move")
            self.assertEqual(json.loads(agent.channel.sent[-1])["type"], "input-ack")

    async def test_disabled_input_returns_error_without_backend(self):
        config = SimpleNamespace(policy=AgentPolicy(), download_dir=Path("."), send_file=None, monitor=1, fps=15, max_width=1920)
        agent = HostAgent(config)
        agent.channel = FakeChannel()
        await agent._handle_data(json.dumps({"type": "input", "event": {"kind": "key", "key": "a", "pressed": True}}), None)
        response = json.loads(agent.channel.sent[-1])
        self.assertEqual(response["type"], "error")
        self.assertEqual(response["code"], "command_rejected")


if __name__ == "__main__":
    unittest.main()
