from __future__ import annotations

import hashlib
import json
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_CHUNK_BYTES = 256 * 1024
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode_browser_chunk(offset: int, data: bytes) -> bytes:
    if offset < 0 or offset > 0xFFFFFFFFFFFFFFFF:
        raise ValueError("offset is outside uint64 range")
    if not data:
        raise ValueError("empty chunks are not allowed")
    return struct.pack(">Q", offset) + bytes(data)


def decode_browser_chunk(payload: bytes, *, max_chunk_bytes: int = DEFAULT_MAX_CHUNK_BYTES) -> tuple[int, bytes]:
    if len(payload) < 9:
        raise ValueError("binary chunk envelope is truncated")
    offset = struct.unpack(">Q", payload[:8])[0]
    chunk = payload[8:]
    if len(chunk) > max_chunk_bytes:
        raise ValueError("binary chunk exceeds limit")
    return offset, chunk


def safe_basename(name: str, fallback: str = "download.bin") -> str:
    cleaned = _SAFE_NAME.sub("_", str(name or "").replace("\\", "_").replace("/", "_").replace("\x00", "_")).strip(" .")
    return cleaned[:240] or fallback


@dataclass(frozen=True)
class FileManifest:
    name: str
    size: int
    mime: str
    sha256: str

    @classmethod
    def from_message(cls, message: dict[str, Any], *, max_bytes: int) -> "FileManifest":
        if message.get("type") != "file-start":
            raise ValueError("expected file-start")
        size = message.get("size")
        digest = str(message.get("sha256", "")).lower()
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > max_bytes:
            raise ValueError("invalid or oversized file")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("valid SHA-256 is required")
        return cls(safe_basename(str(message.get("name", "download.bin"))), size, str(message.get("mime", "application/octet-stream"))[:160], digest)


class FileReceiver:
    """Ordered, bounded receiver shared by aiortc and unit tests."""

    def __init__(self, *, max_bytes: int = DEFAULT_MAX_FILE_BYTES, max_chunk_bytes: int = DEFAULT_MAX_CHUNK_BYTES) -> None:
        self.max_bytes = max_bytes
        self.max_chunk_bytes = max_chunk_bytes
        self.manifest: FileManifest | None = None
        self._chunks: list[bytes] = []
        self.received = 0

    def start(self, message: dict[str, Any]) -> FileManifest:
        if self.manifest is not None:
            raise ValueError("another file transfer is already active")
        self.manifest = FileManifest.from_message(message, max_bytes=self.max_bytes)
        self._chunks.clear()
        self.received = 0
        return self.manifest

    def add_chunk(self, payload: bytes) -> int:
        if self.manifest is None:
            raise ValueError("binary chunk arrived before file-start")
        offset, chunk = decode_browser_chunk(payload, max_chunk_bytes=self.max_chunk_bytes)
        if offset != self.received:
            self.abort()
            raise ValueError("file chunks overlap or are out of order")
        if self.received + len(chunk) > self.manifest.size or self.received + len(chunk) > self.max_bytes:
            self.abort()
            raise ValueError("file exceeds declared size")
        self._chunks.append(chunk)
        self.received += len(chunk)
        return self.received

    def complete(self, message: dict[str, Any], destination: Path | None = None) -> bytes | Path:
        if self.manifest is None or message.get("type") != "file-complete":
            raise ValueError("file completion without an active transfer")
        manifest = self.manifest
        data = b"".join(self._chunks)
        self.abort()
        if len(data) != manifest.size or sha256_hex(data) != manifest.sha256:
            raise ValueError("file size or SHA-256 mismatch")
        if destination is None:
            return data
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        tmp = destination.with_name(f".{destination.name}.part")
        tmp.write_bytes(data)
        tmp.replace(destination)
        return destination

    def abort(self) -> None:
        self.manifest = None
        self._chunks.clear()
        self.received = 0


def encode_file_messages(path: Path, *, max_bytes: int = DEFAULT_MAX_FILE_BYTES, chunk_bytes: int = 16 * 1024):
    path = Path(path)
    size = path.stat().st_size
    if size > max_bytes:
        raise ValueError(f"file exceeds {max_bytes} byte limit")
    data = path.read_bytes()
    digest = sha256_hex(data)
    yield json.dumps({"type": "file-start", "name": safe_basename(path.name), "size": size, "mime": "application/octet-stream", "sha256": digest}, separators=(",", ":"))
    for offset in range(0, len(data), chunk_bytes):
        yield encode_browser_chunk(offset, data[offset:offset + chunk_bytes])
    yield json.dumps({"type": "file-complete", "name": safe_basename(path.name)}, separators=(",", ":"))
