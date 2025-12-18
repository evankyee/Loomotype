"""
Video Composer

Assembles the final personalized video by:
1. Splicing lip-synced segments into the original video
2. Keeping all other parts of the original intact
3. Ensuring seamless transitions

The key insight is that we want to preserve as much of the
original video as possible - only the lip-synced segments change.
"""

import tempfile
import shutil
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, List
from loguru import logger

from ..core.ffmpeg_utils import FFmpegProcessor
from ..core.video_info import get_video_info


@dataclass
class ProcessedSegment:
    """A segment that has been processed (lip-synced)."""
    video_path: Path      # Path to the processed video segment
    start_time: float     # Start time in source video
    end_time: float       # End time of processed segment (may differ from original)
    original_end_time: Optional[float] = None  # Original end time (for timing adjustment)


class VideoComposer:
    """
    Composes the final video from original + processed segments.

    The strategy:
    1. Identify all processed segments and their timings
    2. Extract unprocessed segments from original
    3. Concatenate in order: [original][processed][original][processed]...
    4. The result has the same duration as the original

    This preserves ~90% of the original video pixels.
    """

    def __init__(self):
        self.temp_dir = Path(tempfile.mkdtemp())
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def cleanup(self):
        """Remove temp files."""
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def compose(
        self,
        original_video: Path,
        processed_segments: list[ProcessedSegment],
        output_path: Path,
    ) -> Path:
        """
        Compose final video by splicing processed segments into original.

        Args:
            original_video: The original base video
            processed_segments: List of ProcessedSegment with lip-synced videos
            output_path: Where to save the final video

        Returns:
            Path to the composed video
        """
        original_video = Path(original_video)
        output_path = Path(output_path)

        if not original_video.exists():
            raise FileNotFoundError(f"Original video not found: {original_video}")

        # Get video info
        info = get_video_info(original_video)
        total_duration = info.duration

        logger.info(
            f"Composing video: {total_duration:.2f}s, "
            f"{len(processed_segments)} processed segments"
        )

        if not processed_segments:
            # No segments to replace, just copy
            shutil.copy(original_video, output_path)
            return output_path

        # Sort segments by start time
        sorted_segments = sorted(processed_segments, key=lambda s: s.start_time)

        # Build list of all segments to concatenate
        segments_to_concat = []
        current_time = 0.0

        for i, seg in enumerate(sorted_segments):
            # Add original segment before this processed segment
            if current_time < seg.start_time:
                original_segment = self._extract_original_segment(
                    original_video,
                    current_time,
                    seg.start_time,
                    f"original_{i}_before.mp4",
                )
                segments_to_concat.append(original_segment)
                logger.info(f"[COMPOSE] Added original segment: {current_time:.2f}s - {seg.start_time:.2f}s -> {original_segment}")

            # Add the processed segment (duration may differ from original)
            segments_to_concat.append(seg.video_path)
            logger.info(f"[COMPOSE] Added PROCESSED segment: {seg.video_path}")
            logger.info(f"[COMPOSE]   -> This replaces original {seg.start_time:.2f}s - {seg.original_end_time or seg.end_time:.2f}s")

            # Verify the processed segment exists
            if not seg.video_path.exists():
                logger.error(f"[COMPOSE] ERROR: Processed segment does not exist: {seg.video_path}")
            else:
                logger.info(f"[COMPOSE]   -> File size: {seg.video_path.stat().st_size} bytes")

            # Resume from original_end_time if specified (handles duration changes)
            # This allows processed segments to be longer/shorter than original
            resume_from = seg.original_end_time if seg.original_end_time else seg.end_time
            current_time = resume_from
            logger.info(f"[COMPOSE] Will resume original video from: {current_time:.2f}s")

        # Add remaining original segment after last processed segment
        if current_time < total_duration:
            original_segment = self._extract_original_segment(
                original_video,
                current_time,
                total_duration,
                "original_final.mp4",
            )
            segments_to_concat.append(original_segment)
            logger.debug(f"Original segment: {current_time:.2f}s - {total_duration:.2f}s")

        # Concatenate all segments
        logger.info(f"[COMPOSE] Final concatenation order ({len(segments_to_concat)} segments):")
        for idx, seg_path in enumerate(segments_to_concat):
            seg_info = get_video_info(seg_path)
            logger.info(f"[COMPOSE]   {idx+1}. {seg_path.name} ({seg_info.duration:.2f}s)")

        FFmpegProcessor.concatenate_segments(
            segment_paths=segments_to_concat,
            output_path=output_path,
            reencode=True,  # Ensure compatibility between segments
        )

        # Verify output duration
        output_info = get_video_info(output_path)
        duration_diff = abs(output_info.duration - total_duration)

        if duration_diff > 0.5:
            logger.warning(
                f"Output duration mismatch: {output_info.duration:.2f}s vs "
                f"expected {total_duration:.2f}s (diff: {duration_diff:.2f}s)"
            )
        else:
            logger.info(
                f"Composition complete: {output_info.duration:.2f}s "
                f"(expected: {total_duration:.2f}s)"
            )

        return output_path

    def _extract_original_segment(
        self,
        video_path: Path,
        start_time: float,
        end_time: float,
        filename: str,
    ) -> Path:
        """Extract a segment from the original video."""
        output_path = self.temp_dir / filename

        FFmpegProcessor.extract_segment(
            video_path=video_path,
            start_time=start_time,
            end_time=end_time,
            output_path=output_path,
            reencode=True,  # For clean segment boundaries
        )

        return output_path


def compose_personalized_video(
    original_video: Path,
    processed_segments: list[dict],
    output_path: Path,
) -> Path:
    """
    Convenience function to compose a personalized video.

    Args:
        original_video: Path to original video
        processed_segments: List of dicts with:
            - video_path: Path to processed segment
            - start_time: float
            - end_time: float (new duration, may differ from original)
            - original_end_time: float (optional, where to resume in original)
        output_path: Where to save result

    Returns:
        Path to composed video
    """
    composer = VideoComposer()

    try:
        segments = [
            ProcessedSegment(
                video_path=Path(s["video_path"]),
                start_time=s["start_time"],
                end_time=s["end_time"],
                original_end_time=s.get("original_end_time"),  # May be None
            )
            for s in processed_segments
        ]

        return composer.compose(
            original_video=original_video,
            processed_segments=segments,
            output_path=output_path,
        )

    finally:
        composer.cleanup()
