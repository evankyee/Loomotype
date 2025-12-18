"""
Google Cloud Vision API for object and text detection in video frames.
Used for identifying logos, text, and objects that can be replaced.
"""

import subprocess
import tempfile
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

from google.cloud import vision
from loguru import logger

from ..config import settings


@dataclass
class BoundingBox:
    """Bounding box in percentage coordinates (0-100 range).

    All coordinates are percentages of the frame dimensions:
    - x=25 means 25% from the left edge
    - y=10 means 10% from the top edge
    - width=50 means spanning 50% of frame width
    - height=30 means spanning 30% of frame height
    """
    x: float      # Left edge (0-100 percentage)
    y: float      # Top edge (0-100 percentage)
    width: float  # Width (0-100 percentage)
    height: float # Height (0-100 percentage)

    @property
    def x2(self) -> float:
        return self.x + self.width

    @property
    def y2(self) -> float:
        return self.y + self.height

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.width / 2, self.y + self.height / 2)

    def to_pixels(self, frame_width: int, frame_height: int) -> tuple[int, int, int, int]:
        """Convert percentage coordinates to pixel coordinates (x, y, width, height).

        Since coordinates are stored as 0-100 percentages, we divide by 100
        before multiplying by frame dimensions.
        """
        return (
            int((self.x / 100) * frame_width),
            int((self.y / 100) * frame_height),
            int((self.width / 100) * frame_width),
            int((self.height / 100) * frame_height),
        )

    def clamp(self) -> 'BoundingBox':
        """Return a new BoundingBox with coordinates clamped to valid 0-100 range."""
        return BoundingBox(
            x=max(0, min(100, self.x)),
            y=max(0, min(100, self.y)),
            width=max(0, min(100 - max(0, self.x), self.width)),
            height=max(0, min(100 - max(0, self.y), self.height)),
        )


@dataclass
class DetectedObject:
    """A detected object in a video frame."""
    name: str                    # Object name/label
    confidence: float            # Detection confidence (0-1)
    bounding_box: BoundingBox    # Location in frame
    frame_time: float = 0.0      # Time in video (seconds)


@dataclass
class DetectedText:
    """Detected text in a video frame."""
    text: str                    # The detected text
    confidence: float            # Detection confidence (0-1)
    bounding_box: BoundingBox    # Location in frame
    frame_time: float = 0.0      # Time in video (seconds)
    is_logo: bool = False        # Whether this appears to be a logo


@dataclass
class FrameAnalysis:
    """Analysis results for a single video frame."""
    frame_time: float                         # Time in video (seconds)
    objects: list[DetectedObject] = field(default_factory=list)
    texts: list[DetectedText] = field(default_factory=list)
    logos: list[DetectedObject] = field(default_factory=list)


class GoogleVisionClient:
    """
    Google Cloud Vision API client for video analysis.

    Capabilities:
    - Object detection (localization)
    - Text detection (OCR)
    - Logo detection
    - Face detection
    """

    def __init__(self):
        self.client = vision.ImageAnnotatorClient()

    def analyze_image(self, image_path: Path) -> FrameAnalysis:
        """
        Analyze a single image for objects, text, and logos.

        Args:
            image_path: Path to image file

        Returns:
            FrameAnalysis with detected elements
        """
        from PIL import Image as PILImage

        # Get image dimensions for coordinate normalization
        with PILImage.open(image_path) as img:
            img_width, img_height = img.size

        with open(image_path, "rb") as f:
            content = f.read()

        image = vision.Image(content=content)

        # Request multiple detection types
        features = [
            vision.Feature(type_=vision.Feature.Type.OBJECT_LOCALIZATION),
            vision.Feature(type_=vision.Feature.Type.TEXT_DETECTION),
            vision.Feature(type_=vision.Feature.Type.LOGO_DETECTION),
        ]

        request = vision.AnnotateImageRequest(image=image, features=features)
        response = self.client.annotate_image(request=request)

        if response.error.message:
            raise Exception(f"Vision API error: {response.error.message}")

        return self._parse_response(response, frame_time=0.0, img_width=img_width, img_height=img_height)

    def analyze_video_frames(
        self,
        video_path: Path,
        interval_seconds: float = 1.0,
        max_frames: int = 30,
    ) -> list[FrameAnalysis]:
        """
        Extract frames from video and analyze each one.

        Args:
            video_path: Path to video file
            interval_seconds: Time between extracted frames
            max_frames: Maximum number of frames to analyze

        Returns:
            List of FrameAnalysis for each extracted frame
        """
        video_path = Path(video_path)
        analyses = []

        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)

            # Extract frames using FFmpeg
            logger.info(f"Extracting frames from {video_path.name}...")

            output_pattern = tmpdir / "frame_%04d.jpg"
            subprocess.run([
                "ffmpeg", "-y", "-i", str(video_path),
                "-vf", f"fps=1/{interval_seconds}",
                "-frames:v", str(max_frames),
                "-q:v", "2",  # High quality JPEG
                str(output_pattern)
            ], check=True, capture_output=True)

            # Analyze each frame
            frame_files = sorted(tmpdir.glob("frame_*.jpg"))
            logger.info(f"Analyzing {len(frame_files)} frames...")

            for i, frame_path in enumerate(frame_files):
                frame_time = i * interval_seconds
                logger.debug(f"Analyzing frame at {frame_time}s...")

                try:
                    analysis = self.analyze_image(frame_path)
                    analysis.frame_time = frame_time

                    # Update frame_time in all detections
                    for obj in analysis.objects:
                        obj.frame_time = frame_time
                    for text in analysis.texts:
                        text.frame_time = frame_time
                    for logo in analysis.logos:
                        logo.frame_time = frame_time

                    analyses.append(analysis)
                except Exception as e:
                    logger.warning(f"Failed to analyze frame at {frame_time}s: {e}")

        return analyses

    def find_objects_by_name(
        self,
        video_path: Path,
        object_names: list[str],
        interval_seconds: float = 1.0,
    ) -> dict[str, list[DetectedObject]]:
        """
        Find specific objects in a video by name.

        Args:
            video_path: Path to video file
            object_names: List of object names to find (e.g., ["laptop", "phone", "logo"])
            interval_seconds: Analysis interval

        Returns:
            Dictionary mapping object names to list of detections
        """
        analyses = self.analyze_video_frames(video_path, interval_seconds)

        results = {name.lower(): [] for name in object_names}

        for analysis in analyses:
            # Check objects
            for obj in analysis.objects:
                obj_name_lower = obj.name.lower()
                for search_name in object_names:
                    if search_name.lower() in obj_name_lower or obj_name_lower in search_name.lower():
                        results[search_name.lower()].append(obj)

            # Check logos
            for logo in analysis.logos:
                if "logo" in [n.lower() for n in object_names]:
                    results["logo"].append(logo)

        return results

    def find_text_occurrences(
        self,
        video_path: Path,
        search_text: str,
        interval_seconds: float = 1.0,
    ) -> list[DetectedText]:
        """
        Find occurrences of specific text in a video.

        Args:
            video_path: Path to video file
            search_text: Text to search for
            interval_seconds: Analysis interval

        Returns:
            List of DetectedText for matching text
        """
        analyses = self.analyze_video_frames(video_path, interval_seconds)
        search_lower = search_text.lower()

        matches = []
        for analysis in analyses:
            for text in analysis.texts:
                if search_lower in text.text.lower():
                    matches.append(text)

        return matches

    def get_all_text(
        self,
        video_path: Path,
        interval_seconds: float = 1.0,
    ) -> list[DetectedText]:
        """Get all detected text in a video."""
        analyses = self.analyze_video_frames(video_path, interval_seconds)

        all_text = []
        for analysis in analyses:
            all_text.extend(analysis.texts)

        return all_text

    def _parse_response(
        self,
        response: vision.AnnotateImageResponse,
        frame_time: float,
        img_width: int = 1920,
        img_height: int = 1080,
    ) -> FrameAnalysis:
        """Parse Vision API response into FrameAnalysis.

        Args:
            response: Vision API response
            frame_time: Time in video (seconds)
            img_width: Image width for normalizing text/logo coords (pixels to 0-1)
            img_height: Image height for normalizing text/logo coords (pixels to 0-1)
        """
        objects = []
        texts = []
        logos = []

        # Parse object localizations (normalized_vertices are 0-1, convert to 0-100 percentage)
        for obj in response.localized_object_annotations:
            vertices = obj.bounding_poly.normalized_vertices
            if len(vertices) >= 4:
                x_min = min(v.x for v in vertices)
                y_min = min(v.y for v in vertices)
                x_max = max(v.x for v in vertices)
                y_max = max(v.y for v in vertices)

                detected = DetectedObject(
                    name=obj.name,
                    confidence=obj.score,
                    bounding_box=BoundingBox(
                        x=100 * x_min,           # Percentage (0-100)
                        y=100 * y_min,           # Percentage (0-100)
                        width=100 * (x_max - x_min),   # Percentage (0-100)
                        height=100 * (y_max - y_min),  # Percentage (0-100)
                    ),
                    frame_time=frame_time,
                )
                objects.append(detected)

        # Parse text annotations
        # NOTE: text_annotations returns PIXEL coordinates, not normalized!
        # We must normalize them to 0-1 range using image dimensions
        if response.text_annotations:
            # First annotation is the full text, rest are individual words/blocks
            for i, text_ann in enumerate(response.text_annotations):
                if i == 0:
                    continue  # Skip full text annotation

                vertices = text_ann.bounding_poly.vertices
                if len(vertices) >= 4:
                    # Get pixel coordinates
                    x_coords = [v.x for v in vertices]
                    y_coords = [v.y for v in vertices]

                    # Normalize pixel coordinates to 0-1 range
                    x_min_px = min(x_coords)
                    y_min_px = min(y_coords)
                    width_px = max(x_coords) - x_min_px
                    height_px = max(y_coords) - y_min_px

                    detected = DetectedText(
                        text=text_ann.description,
                        confidence=0.9,  # Vision API doesn't provide confidence for text
                        bounding_box=BoundingBox(
                            x=100 * x_min_px / img_width,      # Percentage (0-100)
                            y=100 * y_min_px / img_height,     # Percentage (0-100)
                            width=100 * width_px / img_width,  # Percentage (0-100)
                            height=100 * height_px / img_height,  # Percentage (0-100)
                        ),
                        frame_time=frame_time,
                    )
                    texts.append(detected)

        # Parse logo detections
        # NOTE: logo_annotations also returns PIXEL coordinates, not normalized!
        for logo_ann in response.logo_annotations:
            vertices = logo_ann.bounding_poly.vertices
            if len(vertices) >= 4:
                # Get pixel coordinates
                x_coords = [v.x for v in vertices]
                y_coords = [v.y for v in vertices]

                # Normalize pixel coordinates to 0-1 range
                x_min_px = min(x_coords)
                y_min_px = min(y_coords)
                width_px = max(x_coords) - x_min_px
                height_px = max(y_coords) - y_min_px

                detected = DetectedObject(
                    name=logo_ann.description,
                    confidence=logo_ann.score,
                    bounding_box=BoundingBox(
                        x=100 * x_min_px / img_width,      # Percentage (0-100)
                        y=100 * y_min_px / img_height,     # Percentage (0-100)
                        width=100 * width_px / img_width,  # Percentage (0-100)
                        height=100 * height_px / img_height,  # Percentage (0-100)
                    ),
                    frame_time=frame_time,
                )
                logos.append(detected)

        return FrameAnalysis(
            frame_time=frame_time,
            objects=objects,
            texts=texts,
            logos=logos,
        )


# Convenience functions
def detect_objects_in_video(video_path: Path, interval: float = 1.0) -> list[FrameAnalysis]:
    """Detect objects in a video."""
    client = GoogleVisionClient()
    return client.analyze_video_frames(video_path, interval)


def find_text_in_video(video_path: Path, search_text: str) -> list[DetectedText]:
    """Find specific text in a video."""
    client = GoogleVisionClient()
    return client.find_text_occurrences(video_path, search_text)
