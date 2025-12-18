"""
Central configuration for the personalization engine.
Uses environment variables with sensible defaults.
"""

import os
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import Optional
from pathlib import Path


class Settings(BaseSettings):
    # API Keys (required for full functionality)
    elevenlabs_api_key: Optional[str] = Field(default=None, alias="ELEVENLABS_API_KEY")
    synclabs_api_key: Optional[str] = Field(default=None, alias="SYNCLABS_API_KEY")

    # GCP (optional for local testing)
    gcp_project_id: Optional[str] = Field(default=None, alias="GCP_PROJECT_ID")
    gcp_region: str = Field(default="us-central1", alias="GCP_REGION")
    gcs_bucket: Optional[str] = Field(default=None, alias="GCS_BUCKET")
    firestore_collection: str = Field(default="personalization_jobs", alias="FIRESTORE_COLLECTION")

    # Directories
    temp_dir: Path = Field(default=Path("/tmp/personalize"), alias="TEMP_DIR")
    output_dir: Path = Field(default=Path("./output"), alias="OUTPUT_DIR")

    # Video Quality (CRF 18 = visually lossless)
    video_crf: int = Field(default=18, alias="VIDEO_CRF")
    audio_bitrate: str = Field(default="192k", alias="AUDIO_BITRATE")

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "populate_by_name": True,
    }


# Lazy-load settings to avoid errors when env vars not set
_settings: Optional[Settings] = None


def get_settings() -> Settings:
    """Get settings, initializing if needed."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


# For backwards compatibility
settings = get_settings()
