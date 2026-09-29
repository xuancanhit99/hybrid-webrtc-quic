import argparse
import tempfile
import unittest
from pathlib import Path

from hybrid_agent.capture import scaled_dimensions
from hybrid_agent.config import build_parser, config_from_args, load_config_file, parse_args
from hybrid_agent.policy import CONSENT_PHRASE


class ConfigCaptureTests(unittest.TestCase):
    def test_capture_dimensions_preserve_even_aspect(self):
        self.assertEqual(scaled_dimensions(1920, 1080, 1920), (1920, 1080))
        width, height = scaled_dimensions(3840, 2160, 1920)
        self.assertEqual((width, height), (1920, 1080))

    def test_config_requires_explicit_http_and_input_consent(self):
        parser = build_parser()
        with tempfile.TemporaryDirectory() as directory:
            consent = Path(directory) / "consent.txt"
            consent.write_text(CONSENT_PHRASE, encoding="utf-8")
            args = parser.parse_args(["--session-id", "ses_test", "--insecure-http", "--allow-input", "--consent-file", str(consent)])
            config = config_from_args(args)
            self.assertTrue(config.policy.allow_input)
            with self.assertRaises(ValueError):
                config_from_args(parser.parse_args(["--session-id", "ses_test"]))

    def test_json_config_loads_and_cli_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.json"
            path.write_text('{"control_url":"http://127.0.0.1:8787","session_id":"ses_json","insecure_http":true,"share_screen":true}', encoding="utf-8")
            self.assertEqual(load_config_file(path)["session_id"], "ses_json")
            args = parse_args(["--config", str(path), "--session-id", "ses_cli"])
            self.assertEqual(args.session_id, "ses_cli")
            self.assertTrue(args.share_screen)
            bad = Path(directory) / "bad.json"
            bad.write_text('{"unknown":true}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config_file(bad)


if __name__ == "__main__":
    unittest.main()
