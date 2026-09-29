from __future__ import annotations

import asyncio
from fractions import Fraction


def scaled_dimensions(width: int, height: int, max_width: int) -> tuple[int, int]:
    if width <= max_width:
        return width - width % 2, height - height % 2
    scale = max_width / width
    return max_width - max_width % 2, max(2, round(height * scale) // 2 * 2)


class DesktopVideoTrack:
    """Factory-compatible aiortc track without importing heavy modules at test discovery."""

    def __new__(cls, *args, **kwargs):
        try:
            from aiortc import VideoStreamTrack
            from av import VideoFrame
            import mss
            import numpy as np
        except ImportError as error:
            raise RuntimeError("desktop capture requires aiortc, av, mss and numpy") from error

        class _Track(VideoStreamTrack):
            kind = "video"

            def __init__(self, monitor_index: int = 1, fps: int = 15, max_width: int = 1920, active: bool = False) -> None:
                super().__init__()
                self.monitor_index = monitor_index
                self.fps = fps
                self.max_width = max_width
                self._grabber = None
                self._next_frame_at = 0.0
                self._pts = 0
                self._active = asyncio.Event()
                if active:
                    self._active.set()

            def activate(self) -> None:
                self._active.set()

            async def recv(self):
                await self._active.wait()
                loop = asyncio.get_running_loop()
                interval = 1 / self.fps
                if self._next_frame_at:
                    await asyncio.sleep(max(0, self._next_frame_at - loop.time()))
                self._next_frame_at = max(loop.time(), self._next_frame_at) + interval
                if self._grabber is None:
                    self._grabber = mss.MSS()
                monitors = self._grabber.monitors
                index = self.monitor_index if 0 <= self.monitor_index < len(monitors) else 1
                shot = self._grabber.grab(monitors[index])
                source = VideoFrame.from_ndarray(np.asarray(shot), format="bgra")
                width, height = scaled_dimensions(source.width, source.height, self.max_width)
                frame = source.reformat(width=width, height=height, format="yuv420p")
                frame.pts = self._pts
                frame.time_base = Fraction(1, 90_000)
                self._pts += round(90_000 / self.fps)
                return frame

            def stop(self) -> None:
                if self._grabber is not None:
                    self._grabber.close()
                    self._grabber = None
                super().stop()

        return _Track(*args, **kwargs)
