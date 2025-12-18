"""
Visual Overlays using FFmpeg

This module creates overlay images and applies them to video
using FFmpeg's overlay filter. No frame-by-frame processing.

Key insight: We render text/logos to PNG images, then use
FFmpeg to composite them onto the video in a single pass.
"""

import tempfile
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
from PIL import Image, ImageDraw, ImageFont
from loguru import logger
import httpx

from ..core.ffmpeg_utils import FFmpegProcessor
from ..core.video_info import get_video_info


@dataclass
class TextOverlay:
    """Configuration for a text overlay."""
    text: str
    x: int                           # X position in pixels
    y: int                           # Y position in pixels
    start_time: Optional[float] = None  # None = start of video
    end_time: Optional[float] = None    # None = end of video
    font_size: int = 48
    font_path: Optional[str] = None  # Path to TTF font
    color: tuple = (255, 255, 255)   # RGB
    background_color: Optional[tuple] = None  # RGB or None for transparent
    padding: int = 10                # Padding around text


@dataclass
class ImageOverlay:
    """Configuration for an image overlay."""
    image_path: Path                 # Path to PNG image
    x: int                           # X position in pixels
    y: int                           # Y position in pixels
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    width: Optional[int] = None      # Resize width (optional)
    height: Optional[int] = None     # Resize height (optional)


class OverlayEngine:
    """
    Apply visual overlays to video using FFmpeg.

    Usage:
        engine = OverlayEngine()

        # Add text
        text_overlay = engine.create_text_overlay(
            text="Hello Alice",
            x=100, y=50,
            start_time=0, end_time=5,
        )

        # Add logo
        logo_overlay = engine.create_image_overlay(
            image_url="https://example.com/logo.png",
            x=1720, y=50,
            width=150,
        )

        # Apply all overlays
        output = engine.apply_overlays(
            video_path=input_video,
            overlays=[text_overlay, logo_overlay],
            output_path=output_video,
        )
    """

    def __init__(self, temp_dir: Optional[Path] = None):
        self.temp_dir = temp_dir or Path(tempfile.mkdtemp())
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self._overlay_counter = 0

    def create_text_overlay(
        self,
        text: str,
        x: int,
        y: int,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        font_size: int = 48,
        font_path: Optional[str] = None,
        color: tuple = (255, 255, 255),
        background_color: Optional[tuple] = None,
        padding: int = 10,
    ) -> ImageOverlay:
        """
        Create a text overlay by rendering text to a PNG image.

        Returns an ImageOverlay that can be applied to video.
        """
        logger.debug(f"Creating text overlay: '{text}'")

        # Load font
        try:
            if font_path:
                font = ImageFont.truetype(font_path, font_size)
            else:
                # Try to use a system font
                try:
                    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
                except OSError:
                    try:
                        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
                    except OSError:
                        font = ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()

        # Calculate text size
        dummy_img = Image.new("RGBA", (1, 1))
        draw = ImageDraw.Draw(dummy_img)
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]

        # Create image with padding
        img_width = text_width + 2 * padding
        img_height = text_height + 2 * padding

        if background_color:
            img = Image.new("RGBA", (img_width, img_height), (*background_color, 255))
        else:
            img = Image.new("RGBA", (img_width, img_height), (0, 0, 0, 0))

        draw = ImageDraw.Draw(img)
        draw.text((padding, padding), text, font=font, fill=(*color, 255))

        # Save to temp file
        self._overlay_counter += 1
        overlay_path = self.temp_dir / f"text_overlay_{self._overlay_counter}.png"
        img.save(overlay_path, "PNG")

        logger.debug(f"Text overlay created: {overlay_path} ({img_width}x{img_height})")

        return ImageOverlay(
            image_path=overlay_path,
            x=x,
            y=y,
            start_time=start_time,
            end_time=end_time,
        )

    def create_image_overlay(
        self,
        image_source: str | Path,
        x: int,
        y: int,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> ImageOverlay:
        """
        Create an image overlay from a file or URL.

        Handles downloading from URLs and resizing.
        """
        self._overlay_counter += 1
        overlay_path = self.temp_dir / f"image_overlay_{self._overlay_counter}.png"

        # Load image from file or URL
        if isinstance(image_source, Path) or not str(image_source).startswith(("http://", "https://", "gs://")):
            # Local file
            img = Image.open(image_source)
        elif str(image_source).startswith("gs://"):
            # GCS path - download via storage client
            from ..pipeline.storage import StorageClient
            storage = StorageClient()
            local_path = storage.download(str(image_source))
            img = Image.open(local_path)
        else:
            # HTTP URL - download
            logger.debug(f"Downloading image from {image_source}")
            response = httpx.get(str(image_source), follow_redirects=True)
            response.raise_for_status()

            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                f.write(response.content)
                temp_path = Path(f.name)

            img = Image.open(temp_path)
            temp_path.unlink()

        # Convert to RGBA for transparency support
        img = img.convert("RGBA")

        # Resize if needed
        if width and height:
            img = img.resize((width, height), Image.Resampling.LANCZOS)
        elif width:
            ratio = width / img.width
            img = img.resize((width, int(img.height * ratio)), Image.Resampling.LANCZOS)
        elif height:
            ratio = height / img.height
            img = img.resize((int(img.width * ratio), height), Image.Resampling.LANCZOS)

        # Save
        img.save(overlay_path, "PNG")

        logger.debug(f"Image overlay created: {overlay_path} ({img.width}x{img.height})")

        return ImageOverlay(
            image_path=overlay_path,
            x=x,
            y=y,
            start_time=start_time,
            end_time=end_time,
            width=img.width,
            height=img.height,
        )

    def apply_overlays(
        self,
        video_path: Path,
        overlays: list[ImageOverlay],
        output_path: Path,
    ) -> Path:
        """
        Apply multiple overlays to a video in a single FFmpeg pass.

        This is efficient because FFmpeg processes all overlays
        in one pass through the video.
        """
        video_path = Path(video_path)
        output_path = Path(output_path)

        if not overlays:
            # No overlays, just copy
            import shutil
            shutil.copy(video_path, output_path)
            return output_path

        logger.info(f"Applying {len(overlays)} overlays to video")

        # Convert ImageOverlay objects to dict format for FFmpegProcessor
        overlay_dicts = []
        for overlay in overlays:
            overlay_dicts.append({
                "path": overlay.image_path,
                "x": overlay.x,
                "y": overlay.y,
                "start_time": overlay.start_time,
                "end_time": overlay.end_time,
            })

        # Apply all overlays in one pass
        FFmpegProcessor.apply_multiple_overlays(
            video_path=video_path,
            overlays=overlay_dicts,
            output_path=output_path,
        )

        return output_path

    def cleanup(self):
        """Remove temp files."""
        import shutil
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir, ignore_errors=True)


def apply_visual_replacements(
    video_path: Path,
    replacements: list[dict],
    output_path: Path,
    video_width: int,
    video_height: int,
) -> Path:
    """
    Convenience function to apply visual replacements.

    Each replacement dict should have:
    - type: "text" or "image"
    - x, y: Position (0-1 relative coordinates)
    - start_time, end_time: Timing
    - For text: text, font_size, color
    - For image: image_source, width, height
    """
    engine = OverlayEngine()

    try:
        overlays = []

        for rep in replacements:
            # Convert relative coordinates to pixels
            x = int(rep["x"] * video_width)
            y = int(rep["y"] * video_height)

            if rep["type"] == "text":
                overlay = engine.create_text_overlay(
                    text=rep["text"],
                    x=x,
                    y=y,
                    start_time=rep.get("start_time"),
                    end_time=rep.get("end_time"),
                    font_size=rep.get("font_size", 48),
                    color=rep.get("color", (255, 255, 255)),
                    background_color=rep.get("background_color"),
                )
            elif rep["type"] == "image":
                overlay = engine.create_image_overlay(
                    image_source=rep["image_source"],
                    x=x,
                    y=y,
                    start_time=rep.get("start_time"),
                    end_time=rep.get("end_time"),
                    width=rep.get("width"),
                    height=rep.get("height"),
                )
            else:
                logger.warning(f"Unknown replacement type: {rep['type']}")
                continue

            overlays.append(overlay)

        return engine.apply_overlays(video_path, overlays, output_path)

    finally:
        engine.cleanup()
