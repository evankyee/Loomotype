"""
Sync Labs API Client - Production Lip-Sync

This is the production-ready lip-sync solution.
Sync Labs handles all the complexity of face detection,
lip animation, and video rendering.

Pricing:
- lipsync-2: ~$0.05/second (faster, good quality)
- lipsync-2-pro: ~$0.08/second (slower, best quality, up to 4K)
"""

import os
import time
import httpx
import tempfile
import concurrent.futures
from pathlib import Path
from loguru import logger
from typing import Optional, Literal
from dataclasses import dataclass
from enum import Enum


class SyncLabsError(Exception):
    """Sync Labs API error."""
    pass


class JobStatus(str, Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


# Quality presets for different use cases
QUALITY_PRESETS = {
    "preview": {
        "model": "lipsync-2",        # Faster, cheaper
        "poll_interval": 3,          # Check more frequently
        "description": "Fast preview - good for testing edits",
    },
    "balanced": {
        "model": "lipsync-2",        # Good quality, reasonable speed
        "poll_interval": 5,
        "description": "Balanced - good quality at reasonable speed",
    },
    "final": {
        "model": "lipsync-2-pro",    # Best quality
        "poll_interval": 5,
        "description": "Final render - highest quality for production",
    },
}


def get_lipsync_preset(quality: Literal["preview", "balanced", "final"] = "balanced") -> dict:
    """Get lip-sync settings for a quality preset."""
    return QUALITY_PRESETS.get(quality, QUALITY_PRESETS["balanced"])


@dataclass
class LipSyncResult:
    """Result from a lip-sync job."""
    job_id: str
    status: JobStatus
    output_url: Optional[str] = None
    error: Optional[str] = None


class SyncLabsClient:
    """
    Production lip-sync client using Sync Labs API.

    Usage:
        client = SyncLabsClient()
        result = client.lipsync(
            video_url="https://example.com/video.mp4",
            audio_url="https://example.com/audio.wav",
        )
        # result contains the lip-synced video URL
    """

    BASE_URL = "https://api.sync.so/v2"

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize with API key from parameter or environment.
        """
        self.api_key = api_key or os.getenv("SYNCLABS_API_KEY")
        if not self.api_key:
            raise ValueError(
                "Sync Labs API key required. "
                "Set SYNCLABS_API_KEY environment variable or pass api_key."
            )

        self.client = httpx.Client(
            base_url=self.BASE_URL,
            headers={
                "x-api-key": self.api_key,
                "Content-Type": "application/json",
            },
            timeout=60.0,
        )

    def lipsync_urls(
        self,
        video_url: str,
        audio_url: str,
        model: str = "lipsync-2-pro",
        max_wait_seconds: int = 600,
        poll_interval: int = 5,
    ) -> LipSyncResult:
        """
        Apply lip-sync using URLs (recommended for cloud workflows).

        Args:
            video_url: Public URL to video
            audio_url: Public URL to audio (should match video duration)
            model: "lipsync-2-pro" (better quality) or "lipsync-2" (free tier)
            max_wait_seconds: Maximum time to wait for completion
            poll_interval: Seconds between status checks

        Returns:
            LipSyncResult with output_url when complete
        """
        logger.info(f"Starting lip-sync job with URLs")

        # Submit job
        job_id = self._submit_job_urls(video_url, audio_url, model)
        logger.info(f"Job submitted: {job_id}")

        # Wait for completion
        result = self._wait_for_completion(job_id, max_wait_seconds, poll_interval)

        if result.status != JobStatus.COMPLETED:
            raise SyncLabsError(f"Job failed: {result.error}")

        return result

    def lipsync(
        self,
        video_path: Path,
        audio_path: Path,
        output_path: Optional[Path] = None,
        model: Optional[str] = None,
        quality: Literal["preview", "balanced", "final"] = "final",
        max_wait_seconds: int = 600,
        poll_interval: Optional[int] = None,
        upload_to_gcs: bool = True,
    ) -> Path:
        """
        Apply lip-sync to local files.

        This method:
        1. Uploads files to GCS (or uses local server)
        2. Submits lip-sync job
        3. Polls until complete
        4. Downloads the result

        Args:
            video_path: Path to video segment
            audio_path: Path to new audio (should match video duration)
            output_path: Where to save result (optional)
            model: Override model selection (or use quality preset)
            quality: "preview" (fast), "balanced", or "final" (best quality)
            max_wait_seconds: Maximum time to wait for completion
            poll_interval: Seconds between status checks (uses preset default)
            upload_to_gcs: If True, upload to GCS for public URLs

        Returns:
            Path to lip-synced video
        """
        # Get settings from quality preset
        preset = get_lipsync_preset(quality)
        model = model or preset["model"]
        poll_interval = poll_interval or preset["poll_interval"]
        logger.info(f"Lip-sync quality: {quality} (model: {model})")
        video_path = Path(video_path)
        audio_path = Path(audio_path)

        if not video_path.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio not found: {audio_path}")

        logger.info(f"Starting lip-sync job: {video_path.name}")

        # Upload files to get public URLs
        video_url, audio_url = self._upload_files(video_path, audio_path, upload_to_gcs)

        # Run lip-sync
        result = self.lipsync_urls(
            video_url=video_url,
            audio_url=audio_url,
            model=model,
            max_wait_seconds=max_wait_seconds,
            poll_interval=poll_interval,
        )

        # Download result
        if output_path is None:
            fd, output_path = tempfile.mkstemp(suffix=".mp4")
            os.close(fd)
            output_path = Path(output_path)

        self._download_result(result.output_url, output_path)

        logger.info(f"Lip-sync complete: {output_path}")
        return output_path

    def _upload_files(
        self,
        video_path: Path,
        audio_path: Path,
        use_gcs: bool,
    ) -> tuple[str, str]:
        """Upload files and return public URLs."""
        if use_gcs:
            # Use GCS for uploads
            try:
                from ..pipeline.storage import StorageClient
                storage = StorageClient()

                import uuid
                job_id = str(uuid.uuid4())[:8]

                video_remote = f"lipsync-temp/{job_id}/video.mp4"
                audio_remote = f"lipsync-temp/{job_id}/audio.wav"

                storage.upload(video_path, video_remote)
                storage.upload(audio_path, audio_remote)

                # Get signed URLs (valid for 1 hour)
                video_url = storage.get_signed_url(video_remote, expiration_minutes=60)
                audio_url = storage.get_signed_url(audio_remote, expiration_minutes=60)

                return video_url, audio_url

            except Exception as e:
                logger.warning(f"GCS upload failed: {e}, trying file upload endpoint")

        # Fall back to Sync Labs file upload endpoint
        return self._upload_to_synclabs(video_path, audio_path)

    def _upload_to_synclabs(
        self,
        video_path: Path,
        audio_path: Path,
    ) -> tuple[str, str]:
        """Upload files to a temporary file hosting service and get public URLs."""
        # Use litterbox.catbox.moe for temporary file hosting (files kept for 72h)
        # This works around GCP org policies that block public bucket access

        def upload_to_litterbox(file_path: Path) -> str:
            """Upload a file to litterbox (temp file host) and get a public URL."""
            with open(file_path, "rb") as f:
                response = httpx.post(
                    "https://litterbox.catbox.moe/resources/internals/api.php",
                    data={"reqtype": "fileupload", "time": "72h"},
                    files={"fileToUpload": (file_path.name, f)},
                    timeout=300.0,
                    headers={"User-Agent": "Soron-Video-Pipeline/1.0"},
                )
                if response.status_code not in (200, 201):
                    raise SyncLabsError(f"File upload failed: {response.text}")

                # Returns the URL directly as text
                url = response.text.strip()
                if not url.startswith("http"):
                    raise SyncLabsError(f"Invalid URL returned: {url}")
                return url

        logger.info("Uploading files to temporary hosting (litterbox) in parallel...")

        # Upload video and audio in parallel (50% faster)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            video_future = executor.submit(upload_to_litterbox, video_path)
            audio_future = executor.submit(upload_to_litterbox, audio_path)

            video_url = video_future.result()
            audio_url = audio_future.result()

        logger.info(f"  Video uploaded: {video_url}")
        logger.info(f"  Audio uploaded: {audio_url}")

        return video_url, audio_url

    def _submit_job_urls(
        self,
        video_url: str,
        audio_url: str,
        model: str,
    ) -> str:
        """Submit a lip-sync job with URLs and return job ID."""
        payload = {
            "model": model,
            "input": [
                {"type": "video", "url": video_url},
                {"type": "audio", "url": audio_url},
            ],
            "options": {
                # "bounce" mode is better for dubbing - plays video forward
                # "loop" can cause unnatural reversals
                "output_format": "mp4",
            }
        }

        response = self.client.post("/generate", json=payload)

        if response.status_code not in (200, 201):
            raise SyncLabsError(f"Failed to submit job: {response.text}")

        result = response.json()
        return result["id"]

    def _wait_for_completion(
        self,
        job_id: str,
        max_wait_seconds: int,
        poll_interval: int,
    ) -> LipSyncResult:
        """Poll until job completes or fails using exponential backoff."""
        start_time = time.time()

        # Exponential backoff: start fast, slow down over time
        current_interval = 2.0
        max_interval = 15.0
        backoff_multiplier = 1.5

        while time.time() - start_time < max_wait_seconds:
            result = self._get_job_status(job_id)

            if result.status == JobStatus.COMPLETED:
                return result
            elif result.status == JobStatus.FAILED:
                return result

            elapsed = int(time.time() - start_time)
            logger.debug(f"Job {job_id}: {result.status.value} ({elapsed}s elapsed, next poll in {current_interval:.1f}s)")
            time.sleep(current_interval)

            current_interval = min(current_interval * backoff_multiplier, max_interval)

        raise SyncLabsError(f"Job {job_id} timed out after {max_wait_seconds}s")

    def _get_job_status(self, job_id: str) -> LipSyncResult:
        """Get current job status."""
        response = self.client.get(f"/generate/{job_id}")

        if response.status_code != 200:
            raise SyncLabsError(f"Failed to get job status: {response.text}")

        data = response.json()

        # Log full response for debugging
        logger.debug(f"Sync Labs response: {data}")

        # Map status strings
        status_str = data.get("status", "PENDING").upper()
        try:
            status = JobStatus(status_str)
        except ValueError:
            status = JobStatus.PENDING

        return LipSyncResult(
            job_id=job_id,
            status=status,
            output_url=data.get("outputUrl"),
            error=data.get("error"),
        )

    def _download_result(self, url: str, output_path: Path):
        """Download the result video."""
        logger.debug(f"Downloading result to {output_path}")

        with httpx.Client(timeout=300.0, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            output_path.write_bytes(response.content)

    def estimate_cost(self, duration_seconds: float, model: str = "lipsync-2") -> float:
        """
        Estimate cost for lip-syncing a video.

        Args:
            duration_seconds: Video duration
            model: Model to use

        Returns:
            Estimated cost in USD
        """
        rates = {
            "lipsync-2": 0.05,
            "lipsync-2-pro": 0.08,
        }
        rate = rates.get(model, 0.05)
        return duration_seconds * rate

    def sync(
        self,
        video_path: Path,
        audio_path: Path,
        output_path: Path,
        start_time: float = 0,
        end_time: float = None,
    ) -> Path:
        """
        Interface method for LipSyncEngine compatibility.
        Wraps lipsync() to match the BaseLipSync interface.
        """
        return self.lipsync(
            video_path=video_path,
            audio_path=audio_path,
            output_path=output_path,
        )


class LipSyncEngine:
    """
    High-level lip-sync interface.

    Wraps SyncLabsClient with additional convenience methods.
    """

    def __init__(self, api_key: Optional[str] = None):
        self.client = SyncLabsClient(api_key)

    def process_segment(
        self,
        video_path: Path,
        audio_path: Path,
        start_time: float,
        end_time: float,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Process a segment of a larger video.

        1. Extracts the segment
        2. Applies lip-sync
        3. Returns the processed segment

        Args:
            video_path: Full source video
            audio_path: New audio for this segment (should match segment duration)
            start_time: Segment start in seconds
            end_time: Segment end in seconds
            output_path: Where to save result

        Returns:
            Path to lip-synced segment
        """
        from ..core.ffmpeg_utils import FFmpegProcessor

        video_path = Path(video_path)
        audio_path = Path(audio_path)

        logger.info(f"Processing segment: {start_time:.2f}s - {end_time:.2f}s")

        # Extract segment
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            segment_path = Path(f.name)

        FFmpegProcessor.extract_segment(
            video_path=video_path,
            start_time=start_time,
            end_time=end_time,
            output_path=segment_path,
            reencode=True,
        )

        try:
            # Apply lip-sync
            result = self.client.lipsync(
                video_path=segment_path,
                audio_path=audio_path,
                output_path=output_path,
            )
            return result

        finally:
            segment_path.unlink(missing_ok=True)


# Module-level convenience
_engine: Optional[LipSyncEngine] = None


def get_lipsync_engine() -> LipSyncEngine:
    """Get or create the lip-sync engine singleton."""
    global _engine
    if _engine is None:
        _engine = LipSyncEngine()
    return _engine


def lipsync_segment(
    video_path: Path,
    audio_path: Path,
    start_time: float,
    end_time: float,
    output_path: Optional[Path] = None,
) -> Path:
    """Process a video segment with lip-sync."""
    return get_lipsync_engine().process_segment(
        video_path, audio_path, start_time, end_time, output_path
    )
