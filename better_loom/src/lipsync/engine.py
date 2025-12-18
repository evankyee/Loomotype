"""
Lip-Sync Engine

Two options:
1. Wav2Lip (self-hosted) - Free, good quality, requires GPU
2. Sync Labs API - Paid, excellent quality, no infrastructure

We default to Wav2Lip for cost efficiency. Sync Labs can be enabled
for production workloads requiring maximum quality.
"""

from pathlib import Path
from abc import ABC, abstractmethod
from loguru import logger
import tempfile
import os


class BaseLipSync(ABC):
    """Abstract base for lip-sync implementations."""

    @abstractmethod
    def sync(
        self,
        video_path: Path,
        audio_path: Path,
        output_path: Path,
        start_time: float = 0,
        end_time: float = None,
    ) -> Path:
        """
        Apply lip-sync to a video segment.

        Args:
            video_path: Path to the source video
            audio_path: Path to the new audio
            output_path: Where to save the result
            start_time: Start of segment in seconds
            end_time: End of segment in seconds

        Returns:
            Path to the lip-synced video segment
        """
        pass


class LipSyncEngine:
    """
    Main lip-sync interface.

    Handles the full workflow:
    1. Extract the relevant video segment
    2. Apply lip-sync with the new audio
    3. Enhance the result (optional face restoration)
    """

    def __init__(self, backend: str = "synclabs"):
        """
        Args:
            backend: "synclabs" (paid API, production) or "wav2lip" (free, requires GPU)
        """
        self.backend = backend

        if backend == "synclabs":
            from .synclabs import SyncLabsClient
            self.engine = SyncLabsClient()
        elif backend == "wav2lip":
            from .wav2lip import Wav2LipLocal
            self.engine = Wav2LipLocal()
        else:
            raise ValueError(f"Unknown backend: {backend}")

        logger.info(f"LipSync engine initialized with backend: {backend}")

    def process_segment(
        self,
        video_path: str | Path,
        audio_path: str | Path,
        start_time: float,
        end_time: float,
        output_path: str | Path = None,
    ) -> Path:
        """
        Process a single segment - extract, lip-sync, return.

        Args:
            video_path: Full source video
            audio_path: New audio for this segment
            start_time: Where the segment starts (seconds)
            end_time: Where the segment ends (seconds)
            output_path: Where to save (optional, creates temp file)

        Returns:
            Path to the processed segment
        """
        video_path = Path(video_path)
        audio_path = Path(audio_path)

        if output_path is None:
            fd, output_path = tempfile.mkstemp(suffix=".mp4")
            os.close(fd)
        output_path = Path(output_path)

        logger.info(
            f"Processing segment: {start_time:.2f}s - {end_time:.2f}s"
        )

        # Extract the segment first
        segment_video = self._extract_segment(
            video_path, start_time, end_time
        )

        # Apply lip-sync
        result = self.engine.sync(
            video_path=segment_video,
            audio_path=audio_path,
            output_path=output_path,
        )

        # Clean up temp segment
        if segment_video != video_path:
            segment_video.unlink(missing_ok=True)

        logger.info(f"Segment processed: {output_path}")
        return result

    def _extract_segment(
        self,
        video_path: Path,
        start_time: float,
        end_time: float,
    ) -> Path:
        """Extract a video segment using ffmpeg."""
        import ffmpeg

        fd, output = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        duration = end_time - start_time

        # Extract segment without re-encoding (fast)
        (
            ffmpeg
            .input(str(video_path), ss=start_time, t=duration)
            .output(str(output), c="copy")
            .overwrite_output()
            .run(quiet=True)
        )

        return Path(output)
