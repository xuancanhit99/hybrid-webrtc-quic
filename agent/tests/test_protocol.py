import json
import tempfile
import unittest
from pathlib import Path

from hybrid_agent.protocol import (
    FileReceiver,
    decode_browser_chunk,
    encode_browser_chunk,
    encode_file_messages,
    sha256_hex,
)


class ProtocolTests(unittest.TestCase):
    def test_ordered_file_round_trip_and_atomic_write(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.txt"
            destination = Path(directory) / "inbox" / "source.txt"
            source.write_bytes(b"hello from the Windows host" * 100)
            receiver = FileReceiver(max_bytes=100_000)
            for message in encode_file_messages(source, max_bytes=100_000, chunk_bytes=17):
                if isinstance(message, str):
                    payload = json.loads(message)
                    if payload["type"] == "file-start":
                        receiver.start(payload)
                    else:
                        result = receiver.complete(payload, destination)
                        self.assertEqual(result, destination)
                else:
                    receiver.add_chunk(message)
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertFalse(destination.with_name(f".{destination.name}.part").exists())

    def test_overlap_gap_and_hash_are_rejected(self):
        data = b"abc"
        receiver = FileReceiver(max_bytes=100)
        receiver.start({"type": "file-start", "name": "a.txt", "size": 3, "sha256": "0" * 64})
        with self.assertRaisesRegex(ValueError, "out of order"):
            receiver.add_chunk(encode_browser_chunk(1, b"a"))
        receiver.start({"type": "file-start", "name": "a.txt", "size": 3, "sha256": "f" * 64})
        receiver.add_chunk(encode_browser_chunk(0, b"abc"))
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            receiver.complete({"type": "file-complete"})

    def test_chunk_envelope_bounds(self):
        with self.assertRaises(ValueError):
            decode_browser_chunk(b"short")
        with self.assertRaises(ValueError):
            encode_browser_chunk(-1, b"x")


if __name__ == "__main__":
    unittest.main()
