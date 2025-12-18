"""
Motion Tracking for Visual Elements

Tracks regions across frames so replacements follow movement.
Uses OpenCV's tracking algorithms.
"""

import cv2
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from loguru import logger


@dataclass
class BoundingBox:
    """A bounding box with position and size."""
    x: float      # Top-left x (0-1 relative)
    y: float      # Top-left y (0-1 relative)
    width: float  # Width (0-1 relative)
    height: float # Height (0-1 relative)

    def to_pixels(self, frame_width: int, frame_height: int) -> tuple[int, int, int, int]:
        """Convert to pixel coordinates."""
        return (
            int(self.x * frame_width),
            int(self.y * frame_height),
            int(self.width * frame_width),
            int(self.height * frame_height),
        )

    @classmethod
    def from_pixels(cls, x: int, y: int, w: int, h: int, frame_width: int, frame_height: int):
        """Create from pixel coordinates."""
        return cls(
            x=x / frame_width,
            y=y / frame_height,
            width=w / frame_width,
            height=h / frame_height,
        )


@dataclass
class TrackedFrame:
    """Tracking result for a single frame."""
    frame_number: int
    bbox: BoundingBox
    confidence: float


class MotionTracker:
    """
    Track a region across video frames.

    Uses CSRT tracker for accuracy (best for our use case).
    Falls back to KCF for speed if needed.
    """

    def __init__(self, algorithm: str = "csrt"):
        """
        Args:
            algorithm: "csrt" (accurate) or "kcf" (fast)
        """
        self.algorithm = algorithm

    def _create_tracker(self):
        """Create OpenCV tracker instance."""
        if self.algorithm == "csrt":
            return cv2.TrackerCSRT_create()
        elif self.algorithm == "kcf":
            return cv2.TrackerKCF_create()
        else:
            raise ValueError(f"Unknown algorithm: {self.algorithm}")

    def track_region(
        self,
        video_path: Path,
        initial_bbox: BoundingBox,
        start_frame: int = 0,
        end_frame: int = None,
    ) -> list[TrackedFrame]:
        """
        Track a region through a video.

        Args:
            video_path: Path to video file
            initial_bbox: Starting bounding box (relative coords)
            start_frame: Frame to start tracking
            end_frame: Frame to stop (None = end of video)

        Returns:
            List of TrackedFrame for each frame
        """
        video_path = Path(video_path)
        cap = cv2.VideoCapture(str(video_path))

        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if end_frame is None:
            end_frame = total_frames

        logger.info(
            f"Tracking region from frame {start_frame} to {end_frame}"
        )

        # Seek to start frame
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ret, frame = cap.read()
        if not ret:
            raise RuntimeError(f"Cannot read frame {start_frame}")

        # Initialize tracker with first frame
        tracker = self._create_tracker()
        bbox_pixels = initial_bbox.to_pixels(frame_width, frame_height)
        tracker.init(frame, bbox_pixels)

        results = [
            TrackedFrame(
                frame_number=start_frame,
                bbox=initial_bbox,
                confidence=1.0,
            )
        ]

        # Track through remaining frames
        for frame_num in range(start_frame + 1, end_frame):
            ret, frame = cap.read()
            if not ret:
                break

            success, bbox = tracker.update(frame)

            if success:
                x, y, w, h = [int(v) for v in bbox]
                tracked_bbox = BoundingBox.from_pixels(
                    x, y, w, h, frame_width, frame_height
                )
                confidence = 1.0
            else:
                # Tracking lost - use last known position
                tracked_bbox = results[-1].bbox
                confidence = 0.0
                logger.warning(f"Tracking lost at frame {frame_num}")

            results.append(
                TrackedFrame(
                    frame_number=frame_num,
                    bbox=tracked_bbox,
                    confidence=confidence,
                )
            )

        cap.release()
        logger.info(f"Tracking complete: {len(results)} frames")
        return results

    def track_with_homography(
        self,
        video_path: Path,
        corner_points: list[tuple[float, float]],
        start_frame: int = 0,
        end_frame: int = None,
    ) -> list[np.ndarray]:
        """
        Track using feature-based homography.

        Better for planar surfaces (screens, signs) that may
        rotate or change perspective.

        Args:
            video_path: Path to video
            corner_points: 4 corner points defining the region (relative 0-1)
            start_frame: Starting frame
            end_frame: Ending frame

        Returns:
            List of 3x3 homography matrices, one per frame
        """
        video_path = Path(video_path)
        cap = cv2.VideoCapture(str(video_path))

        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if end_frame is None:
            end_frame = total_frames

        # Convert corner points to pixels
        src_points = np.float32([
            [p[0] * frame_width, p[1] * frame_height]
            for p in corner_points
        ])

        # Initialize feature detector
        orb = cv2.ORB_create(nfeatures=500)
        bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

        # Read first frame
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ret, prev_frame = cap.read()
        if not ret:
            raise RuntimeError(f"Cannot read frame {start_frame}")

        prev_gray = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
        prev_kp, prev_desc = orb.detectAndCompute(prev_gray, None)

        # Identity matrix for first frame
        homographies = [np.eye(3, dtype=np.float32)]

        cumulative_H = np.eye(3, dtype=np.float32)

        for frame_num in range(start_frame + 1, end_frame):
            ret, frame = cap.read()
            if not ret:
                break

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            kp, desc = orb.detectAndCompute(gray, None)

            if desc is None or len(kp) < 4:
                # Not enough features - use last homography
                homographies.append(cumulative_H.copy())
                continue

            # Match features
            matches = bf.match(prev_desc, desc)
            matches = sorted(matches, key=lambda x: x.distance)[:50]

            if len(matches) < 4:
                homographies.append(cumulative_H.copy())
                continue

            # Get matched points
            src_pts = np.float32([prev_kp[m.queryIdx].pt for m in matches])
            dst_pts = np.float32([kp[m.trainIdx].pt for m in matches])

            # Find homography
            H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)

            if H is not None:
                cumulative_H = H @ cumulative_H
                homographies.append(cumulative_H.copy())
            else:
                homographies.append(cumulative_H.copy())

            # Update for next iteration
            prev_gray = gray
            prev_kp = kp
            prev_desc = desc

        cap.release()
        return homographies
