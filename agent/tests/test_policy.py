import tempfile
import unittest
from pathlib import Path

from hybrid_agent.input_control import InputController
from hybrid_agent.policy import AgentPolicy, CONSENT_PHRASE, EventRateLimiter, validate_input_event


class FakeBackend:
    def __init__(self):
        self.events = []

    def apply(self, event):
        self.events.append(event)


class PolicyTests(unittest.TestCase):
    def test_input_requires_exact_consent(self):
        with tempfile.TemporaryDirectory() as directory:
            consent = Path(directory) / "consent.txt"
            consent.write_text(CONSENT_PHRASE, encoding="utf-8")
            policy = AgentPolicy(allow_input=True, consent_file=consent)
            policy.validate()
            controller = InputController(policy, FakeBackend())
            event = controller.handle({"kind": "mouse-move", "x": 0.5, "y": 0.25})
            self.assertEqual(event["kind"], "mouse-move")
        with self.assertRaises(ValueError):
            AgentPolicy(allow_input=True, consent_file=None).validate()

    def test_unattended_requires_screen_and_input(self):
        with tempfile.TemporaryDirectory() as directory:
            consent = Path(directory) / "consent.txt"
            consent.write_text(CONSENT_PHRASE, encoding="utf-8")
            with self.assertRaises(ValueError):
                AgentPolicy(unattended=True, allow_input=True, consent_file=consent).validate()
            AgentPolicy(unattended=True, share_screen=True, allow_input=True, consent_file=consent).validate()

    def test_input_schema_rejects_bad_values(self):
        with self.assertRaises(ValueError):
            validate_input_event({"kind": "mouse-move", "x": 2, "y": 0})
        with self.assertRaises(ValueError):
            validate_input_event({"kind": "key", "key": "win", "pressed": True})
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as directory:
            consent = Path(directory) / "consent.txt"
            consent.write_text(CONSENT_PHRASE, encoding="utf-8")
            controller = InputController(AgentPolicy(allow_input=True, consent_file=consent, max_events_per_second=1), backend)
            controller.handle({"kind": "key", "key": "a", "pressed": True})
            with self.assertRaises(ValueError):
                controller.handle({"kind": "key", "key": "b", "pressed": True})

    def test_rate_limiter(self):
        ticks = iter([0.0, 0.1, 1.1])
        limiter = EventRateLimiter(1, clock=lambda: next(ticks))
        self.assertTrue(limiter.accept())
        self.assertFalse(limiter.accept())
        self.assertTrue(limiter.accept())


if __name__ == "__main__":
    unittest.main()
