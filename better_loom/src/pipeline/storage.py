"""
Google Cloud Storage Client

Handles file uploads/downloads for video processing.
"""

from google.cloud import storage
from pathlib import Path
from loguru import logger
import tempfile
import os

from ..config import settings


class StorageClient:
    """
    GCS client for video file management.

    Usage:
        client = StorageClient()

        # Upload
        url = client.upload("local/video.mp4", "videos/output.mp4")

        # Download
        local_path = client.download("videos/input.mp4")

        # Get signed URL for direct access
        url = client.get_signed_url("videos/output.mp4")
    """

    def __init__(self, bucket_name: str = None):
        self.client = storage.Client(project=settings.gcp_project_id)
        self.bucket_name = bucket_name or settings.gcs_bucket
        self.bucket = self.client.bucket(self.bucket_name)

    def upload(
        self,
        local_path: str | Path,
        remote_path: str,
        content_type: str = None,
    ) -> str:
        """
        Upload a file to GCS.

        Returns:
            GCS URI (gs://bucket/path)
        """
        local_path = Path(local_path)

        if content_type is None:
            # Infer content type
            suffix = local_path.suffix.lower()
            content_types = {
                ".mp4": "video/mp4",
                ".mp3": "audio/mpeg",
                ".wav": "audio/wav",
                ".json": "application/json",
                ".png": "image/png",
                ".jpg": "image/jpeg",
            }
            content_type = content_types.get(suffix, "application/octet-stream")

        blob = self.bucket.blob(remote_path)
        blob.upload_from_filename(str(local_path), content_type=content_type)

        uri = f"gs://{self.bucket_name}/{remote_path}"
        logger.debug(f"Uploaded {local_path} to {uri}")
        return uri

    def download(
        self,
        remote_path: str,
        local_path: str | Path = None,
    ) -> Path:
        """
        Download a file from GCS.

        Args:
            remote_path: Path in GCS (without gs://bucket/)
            local_path: Where to save locally (optional)

        Returns:
            Path to downloaded file
        """
        # Handle gs:// URIs
        if remote_path.startswith("gs://"):
            parts = remote_path.replace("gs://", "").split("/", 1)
            remote_path = parts[1] if len(parts) > 1 else parts[0]

        if local_path is None:
            # Create temp file with correct extension
            suffix = Path(remote_path).suffix or ".tmp"
            fd, local_path = tempfile.mkstemp(suffix=suffix)
            os.close(fd)

        local_path = Path(local_path)

        blob = self.bucket.blob(remote_path)
        blob.download_to_filename(str(local_path))

        logger.debug(f"Downloaded {remote_path} to {local_path}")
        return local_path

    def get_signed_url(
        self,
        remote_path: str,
        expiration_minutes: int = 60,
    ) -> str:
        """
        Get a signed URL for direct file access.

        Useful for returning download links to clients.
        Raises exception if signing fails (so caller can use alternative).
        """
        from datetime import timedelta

        blob = self.bucket.blob(remote_path)

        try:
            url = blob.generate_signed_url(
                version="v4",
                expiration=timedelta(minutes=expiration_minutes),
                method="GET",
            )
            return url
        except Exception as e:
            logger.warning(f"Could not generate signed URL: {e}")
            # Try to make public as fallback
            return self.make_public(remote_path)

    def make_public(self, remote_path: str) -> str:
        """
        Make a file publicly accessible and return its public URL.

        Note: Bucket must have uniform bucket-level access disabled
        or appropriate IAM permissions.
        Raises exception if public access cannot be configured.
        """
        blob = self.bucket.blob(remote_path)
        try:
            blob.make_public()
            logger.info(f"Made {remote_path} publicly accessible")
            return f"https://storage.googleapis.com/{self.bucket_name}/{remote_path}"
        except Exception as e:
            logger.warning(f"Could not make blob public: {e}")
            # Raise exception so caller knows to use alternative
            raise RuntimeError(f"Cannot create public URL for {remote_path}: {e}")

    def delete(self, remote_path: str):
        """Delete a file from GCS."""
        blob = self.bucket.blob(remote_path)
        blob.delete()
        logger.debug(f"Deleted {remote_path}")

    def exists(self, remote_path: str) -> bool:
        """Check if a file exists in GCS."""
        blob = self.bucket.blob(remote_path)
        return blob.exists()

    def list_files(self, prefix: str = "") -> list[str]:
        """List files with a given prefix."""
        blobs = self.client.list_blobs(self.bucket_name, prefix=prefix)
        return [blob.name for blob in blobs]
