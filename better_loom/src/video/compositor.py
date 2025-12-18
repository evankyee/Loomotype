"""
Video Compositor - Apply visual replacements to video.
Handles text replacement, image overlays, blur, and object removal.
"""

import json
import subprocess
import tempfile
from pathlib import Path
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Union

from loguru import logger


class ReplacementType(str, Enum):
    """Type of visual replacement."""
    TEXT = "text"           # Replace with new text
    IMAGE = "image"         # Replace with image
    BLUR = "blur"           # Blur the region
    REMOVE = "remove"       # Black out / remove
    COLOR = "color"         # Fill with solid color


@dataclass
class VisualReplacement:
    """Definition of a visual replacement in video."""
    # Region (normalized 0-1 coordinates)
    x: float
    y: float
    width: float
    height: float

    # Timing
    start_time: float      # Start time in seconds
    end_time: float        # End time in seconds

    # Replacement type and content
    type: ReplacementType
    content: Optional[str] = None  # Text content, image path, or color hex

    # Text styling (for TEXT type)
    font_size: int = 48
    font_color: str = "white"
    font: str = "Arial"
    background_color: Optional[str] = None  # Optional background behind text

    # Label for UI
    label: Optional[str] = None


class VideoCompositor:
    """
    Apply visual replacements to video using FFmpeg.

    Supports:
    - Text overlays with custom fonts/colors
    - Image overlays (logos, pictures)
    - Blur regions
    - Black out / remove regions
    - Time-based visibility
    """

    def __init__(self, video_path: Path):
        """
        Initialize compositor with source video.

        Args:
            video_path: Path to source video file
        """
        self.video_path = Path(video_path)
        self.video_info = self._get_video_info()
        self.replacements: list[VisualReplacement] = []

    def _get_video_info(self) -> dict:
        """Get video dimensions and duration using ffprobe."""
        result = subprocess.run([
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_streams", "-show_format",
            str(self.video_path)
        ], capture_output=True, text=True)

        data = json.loads(result.stdout)

        # Find video stream
        video_stream = next(
            (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
            {}
        )

        return {
            "width": int(video_stream.get("width", 1920)),
            "height": int(video_stream.get("height", 1080)),
            "duration": float(data.get("format", {}).get("duration", 0)),
            "fps": eval(video_stream.get("r_frame_rate", "30/1")),
        }

    def add_replacement(self, replacement: VisualReplacement):
        """Add a visual replacement to be applied."""
        self.replacements.append(replacement)

    def add_text_replacement(
        self,
        x: float, y: float, width: float, height: float,
        start_time: float, end_time: float,
        text: str,
        font_size: int = 48,
        font_color: str = "white",
        background_color: Optional[str] = None,
    ):
        """Add a text replacement."""
        self.replacements.append(VisualReplacement(
            x=x, y=y, width=width, height=height,
            start_time=start_time, end_time=end_time,
            type=ReplacementType.TEXT,
            content=text,
            font_size=font_size,
            font_color=font_color,
            background_color=background_color,
        ))

    def add_image_overlay(
        self,
        x: float, y: float, width: float, height: float,
        start_time: float, end_time: float,
        image_path: str,
    ):
        """Add an image overlay."""
        self.replacements.append(VisualReplacement(
            x=x, y=y, width=width, height=height,
            start_time=start_time, end_time=end_time,
            type=ReplacementType.IMAGE,
            content=image_path,
        ))

    def add_blur(
        self,
        x: float, y: float, width: float, height: float,
        start_time: float, end_time: float,
    ):
        """Add a blur region."""
        self.replacements.append(VisualReplacement(
            x=x, y=y, width=width, height=height,
            start_time=start_time, end_time=end_time,
            type=ReplacementType.BLUR,
        ))

    def add_blackout(
        self,
        x: float, y: float, width: float, height: float,
        start_time: float, end_time: float,
        color: str = "black",
    ):
        """Add a blackout/color fill region."""
        self.replacements.append(VisualReplacement(
            x=x, y=y, width=width, height=height,
            start_time=start_time, end_time=end_time,
            type=ReplacementType.COLOR,
            content=color,
        ))

    def render(self, output_path: Path) -> Path:
        """
        Render video with all replacements applied.

        Args:
            output_path: Path for output video

        Returns:
            Path to rendered video
        """
        output_path = Path(output_path)

        if not self.replacements:
            # No replacements, just copy
            subprocess.run([
                "ffmpeg", "-y", "-i", str(self.video_path),
                "-c", "copy", str(output_path)
            ], check=True, capture_output=True)
            return output_path

        # Build FFmpeg filter graph
        filter_complex = self._build_filter_graph()

        # Build FFmpeg command
        cmd = [
            "ffmpeg", "-y",
            "-i", str(self.video_path),
        ]

        # Add image inputs for IMAGE type replacements
        image_inputs = []
        for i, r in enumerate(self.replacements):
            if r.type == ReplacementType.IMAGE and r.content:
                cmd.extend(["-i", r.content])
                image_inputs.append(i)

        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-map", "0:a?",  # Keep audio if present
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            str(output_path)
        ])

        logger.info(f"Rendering video with {len(self.replacements)} replacements...")
        logger.debug(f"Filter: {filter_complex}")

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"FFmpeg error: {result.stderr}")
            raise Exception(f"FFmpeg failed: {result.stderr}")

        logger.info(f"Rendered: {output_path}")
        return output_path

    def _build_filter_graph(self) -> str:
        """Build FFmpeg filter_complex string for all replacements."""
        w = self.video_info["width"]
        h = self.video_info["height"]

        filters = []
        current_input = "[0:v]"
        image_idx = 1  # Start from 1 since 0 is the main video

        for i, r in enumerate(self.replacements):
            output = f"[v{i}]"

            # Convert normalized coords to pixels
            px = int(r.x * w)
            py = int(r.y * h)
            pw = int(r.width * w)
            ph = int(r.height * h)

            # Time enable expression
            enable = f"between(t,{r.start_time},{r.end_time})"

            if r.type == ReplacementType.TEXT:
                # Draw text
                text = r.content.replace("'", "\\'").replace(":", "\\:")
                font_color = r.font_color.replace("#", "0x")

                # Background box if specified
                box_filter = ""
                if r.background_color:
                    bg_color = r.background_color.replace("#", "0x")
                    box_filter = f":box=1:boxcolor={bg_color}:boxborderw=5"

                filter_str = (
                    f"{current_input}drawtext=text='{text}':"
                    f"x={px}:y={py}:"
                    f"fontsize={r.font_size}:"
                    f"fontcolor={font_color}"
                    f"{box_filter}:"
                    f"enable='{enable}'"
                    f"{output}"
                )
                filters.append(filter_str)

            elif r.type == ReplacementType.IMAGE:
                # Scale and overlay image
                scale_filter = f"[{image_idx}:v]scale={pw}:{ph}[img{i}]"
                filters.append(scale_filter)

                overlay_filter = (
                    f"{current_input}[img{i}]overlay={px}:{py}:"
                    f"enable='{enable}'"
                    f"{output}"
                )
                filters.append(overlay_filter)
                image_idx += 1

            elif r.type == ReplacementType.BLUR:
                # Blur region using boxblur
                # Create a blurred version and overlay it on the region
                blur_filter = (
                    f"{current_input}split[main{i}][blur{i}];"
                    f"[blur{i}]crop={pw}:{ph}:{px}:{py},"
                    f"boxblur=20:20[blurred{i}];"
                    f"[main{i}][blurred{i}]overlay={px}:{py}:"
                    f"enable='{enable}'"
                    f"{output}"
                )
                filters.append(blur_filter)

            elif r.type == ReplacementType.COLOR or r.type == ReplacementType.REMOVE:
                # Draw colored rectangle
                color = r.content if r.content else "black"
                if color.startswith("#"):
                    color = "0x" + color[1:]

                filter_str = (
                    f"{current_input}drawbox="
                    f"x={px}:y={py}:w={pw}:h={ph}:"
                    f"color={color}:t=fill:"
                    f"enable='{enable}'"
                    f"{output}"
                )
                filters.append(filter_str)

            current_input = output

        # Final output
        filters.append(f"{current_input}copy[out]")

        return ";".join(filters)


class AudioReplacer:
    """
    Replace audio segments in video with new audio.
    Used for voice regeneration with lip-sync.
    """

    @staticmethod
    def replace_audio_segment(
        video_path: Path,
        new_audio_path: Path,
        start_time: float,
        end_time: float,
        output_path: Path,
    ) -> Path:
        """
        Replace a segment of audio in video.

        Args:
            video_path: Source video
            new_audio_path: New audio to insert
            start_time: Start of segment to replace
            end_time: End of segment to replace
            output_path: Output video path

        Returns:
            Path to output video
        """
        video_path = Path(video_path)
        new_audio_path = Path(new_audio_path)
        output_path = Path(output_path)

        # Get video duration
        result = subprocess.run([
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path)
        ], capture_output=True, text=True)
        duration = float(result.stdout.strip())

        # Build filter to mix audio
        # 1. Take original audio before start_time
        # 2. Insert new audio
        # 3. Take original audio after end_time

        filter_complex = (
            f"[0:a]atrim=0:{start_time}[a1];"
            f"[1:a]atrim=0:{end_time - start_time}[a2];"
            f"[0:a]atrim={end_time}:{duration},asetpts=PTS-STARTPTS[a3];"
            f"[a1][a2][a3]concat=n=3:v=0:a=1[aout]"
        )

        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-i", str(new_audio_path),
            "-filter_complex", filter_complex,
            "-map", "0:v",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            str(output_path)
        ]

        logger.info(f"Replacing audio segment {start_time}s - {end_time}s")
        subprocess.run(cmd, check=True, capture_output=True)

        return output_path

    @staticmethod
    def replace_full_audio(
        video_path: Path,
        audio_path: Path,
        output_path: Path,
    ) -> Path:
        """
        Replace entire audio track in video.

        Args:
            video_path: Source video
            audio_path: New audio track
            output_path: Output video path

        Returns:
            Path to output video
        """
        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-i", str(audio_path),
            "-map", "0:v",
            "-map", "1:a",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            str(output_path)
        ]

        subprocess.run(cmd, check=True, capture_output=True)
        return Path(output_path)
