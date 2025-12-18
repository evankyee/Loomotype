"""
Visual Element Replacer

Handles replacement of text, logos, and images in video frames.
Supports both static overlays and motion-tracked replacements.
"""

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
from dataclasses import dataclass
from loguru import logger
import tempfile
import ffmpeg as ffmpeg_lib

from .tracker import MotionTracker, BoundingBox, TrackedFrame
from ..models import VisualSegment, SegmentType


@dataclass
class ReplacementAsset:
    """An asset to overlay on the video."""
    image: np.ndarray    # BGRA image (with alpha channel)
    width: int
    height: int


class VisualReplacer:
    """
    Replace visual elements in video frames.

    Workflow:
    1. Define replacement regions (from template)
    2. Create replacement assets (text rendered, logos loaded)
    3. Track regions if they move
    4. Composite replacements onto frames
    5. Encode output video
    """

    def __init__(self):
        self.tracker = MotionTracker()
        # Default font for text rendering
        self.default_font = None  # Will use PIL default

    def create_text_asset(
        self,
        text: str,
        width: int,
        height: int,
        font_path: str = None,
        font_size: int = 32,
        color: tuple = (255, 255, 255),
        bg_color: tuple = None,
    ) -> ReplacementAsset:
        """
        Render text to an image asset.

        Args:
            text: Text to render
            width: Target width in pixels
            height: Target height in pixels
            font_path: Path to TTF font (optional)
            font_size: Font size
            color: Text color (R, G, B)
            bg_color: Background color or None for transparent

        Returns:
            ReplacementAsset with rendered text
        """
        # Create transparent image
        if bg_color:
            img = Image.new("RGBA", (width, height), (*bg_color, 255))
        else:
            img = Image.new("RGBA", (width, height), (0, 0, 0, 0))

        draw = ImageDraw.Draw(img)

        # Load font
        try:
            if font_path:
                font = ImageFont.truetype(font_path, font_size)
            else:
                font = ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()

        # Center text
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = (width - text_width) // 2
        y = (height - text_height) // 2

        draw.text((x, y), text, font=font, fill=(*color, 255))

        # Convert to OpenCV format (BGRA)
        cv_img = cv2.cvtColor(np.array(img), cv2.COLOR_RGBA2BGRA)

        return ReplacementAsset(image=cv_img, width=width, height=height)

    def load_image_asset(
        self,
        image_path: str | Path,
        target_width: int = None,
        target_height: int = None,
    ) -> ReplacementAsset:
        """
        Load an image (logo, etc.) as a replacement asset.

        Args:
            image_path: Path to image file
            target_width: Resize to this width (optional)
            target_height: Resize to this height (optional)

        Returns:
            ReplacementAsset
        """
        image_path = Path(image_path)

        # Load with alpha channel
        img = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)

        if img is None:
            raise RuntimeError(f"Cannot load image: {image_path}")

        # Add alpha channel if missing
        if img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

        # Resize if needed
        if target_width and target_height:
            img = cv2.resize(img, (target_width, target_height))
        elif target_width:
            scale = target_width / img.shape[1]
            new_height = int(img.shape[0] * scale)
            img = cv2.resize(img, (target_width, new_height))
        elif target_height:
            scale = target_height / img.shape[0]
            new_width = int(img.shape[1] * scale)
            img = cv2.resize(img, (new_width, target_height))

        return ReplacementAsset(
            image=img,
            width=img.shape[1],
            height=img.shape[0],
        )

    def composite_frame(
        self,
        frame: np.ndarray,
        asset: ReplacementAsset,
        bbox: BoundingBox,
    ) -> np.ndarray:
        """
        Composite a replacement asset onto a frame.

        Handles alpha blending for smooth edges.
        """
        frame_h, frame_w = frame.shape[:2]

        # Convert bbox to pixels
        x, y, w, h = bbox.to_pixels(frame_w, frame_h)

        # Resize asset to fit bbox
        resized = cv2.resize(asset.image, (w, h))

        # Ensure we don't go out of bounds
        x1 = max(0, x)
        y1 = max(0, y)
        x2 = min(frame_w, x + w)
        y2 = min(frame_h, y + h)

        # Adjust asset crop if bbox is partially out of frame
        ax1 = x1 - x
        ay1 = y1 - y
        ax2 = ax1 + (x2 - x1)
        ay2 = ay1 + (y2 - y1)

        if ax2 <= ax1 or ay2 <= ay1:
            return frame  # Completely out of frame

        # Extract regions
        roi = frame[y1:y2, x1:x2]
        overlay = resized[ay1:ay2, ax1:ax2]

        # Alpha blending
        if overlay.shape[2] == 4:
            alpha = overlay[:, :, 3:4] / 255.0
            overlay_rgb = overlay[:, :, :3]

            # Ensure roi is BGR (3 channels)
            if roi.shape[2] == 4:
                roi = roi[:, :, :3]

            # Blend
            blended = (alpha * overlay_rgb + (1 - alpha) * roi).astype(np.uint8)
            frame[y1:y2, x1:x2] = blended
        else:
            frame[y1:y2, x1:x2] = overlay[:, :, :3]

        return frame

    def process_video(
        self,
        video_path: Path,
        segments: list[VisualSegment],
        assets: dict[str, ReplacementAsset],
        output_path: Path,
    ) -> Path:
        """
        Process entire video, replacing all visual segments.

        Args:
            video_path: Source video
            segments: List of visual segments to replace
            assets: Dict mapping placeholder_key to ReplacementAsset
            output_path: Where to save result

        Returns:
            Path to output video
        """
        video_path = Path(video_path)
        output_path = Path(output_path)

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        # Get video properties
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        logger.info(
            f"Processing video: {frame_width}x{frame_height} @ {fps}fps, "
            f"{total_frames} frames"
        )

        # Pre-compute tracking for segments that need it
        tracking_data = {}
        for segment in segments:
            if segment.tracking_reference_frame is not None:
                bbox = BoundingBox(
                    x=segment.x,
                    y=segment.y,
                    width=segment.width,
                    height=segment.height,
                )
                start_frame = int(segment.start_time * fps)
                end_frame = int(segment.end_time * fps)

                tracking_data[segment.id] = self.tracker.track_region(
                    video_path, bbox, start_frame, end_frame
                )

        # Create temp file for frames
        temp_dir = Path(tempfile.mkdtemp())
        frames_pattern = temp_dir / "frame_%06d.png"

        # Process frames
        frame_num = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            current_time = frame_num / fps

            # Apply each segment that's active at this time
            for segment in segments:
                if segment.start_time <= current_time <= segment.end_time:
                    asset = assets.get(segment.placeholder_key)
                    if asset is None:
                        continue

                    # Get bbox (static or tracked)
                    if segment.id in tracking_data:
                        # Find tracked position for this frame
                        tracked_frames = tracking_data[segment.id]
                        start_frame = int(segment.start_time * fps)
                        idx = frame_num - start_frame

                        if 0 <= idx < len(tracked_frames):
                            bbox = tracked_frames[idx].bbox
                        else:
                            bbox = BoundingBox(
                                x=segment.x, y=segment.y,
                                width=segment.width, height=segment.height
                            )
                    else:
                        # Static position
                        bbox = BoundingBox(
                            x=segment.x, y=segment.y,
                            width=segment.width, height=segment.height
                        )

                    frame = self.composite_frame(frame, asset, bbox)

            # Save frame
            frame_path = str(frames_pattern) % frame_num
            cv2.imwrite(frame_path, frame)
            frame_num += 1

        cap.release()

        # Encode frames to video with FFmpeg
        logger.info("Encoding output video")
        (
            ffmpeg_lib
            .input(str(temp_dir / "frame_%06d.png"), framerate=fps)
            .output(
                str(output_path),
                vcodec="libx264",
                crf=18,
                pix_fmt="yuv420p",
            )
            .overwrite_output()
            .run(quiet=True)
        )

        # Clean up temp frames
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)

        logger.info(f"Visual replacement complete: {output_path}")
        return output_path
