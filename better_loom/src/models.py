"""
Core data models for the personalization engine.
These define the structure of templates, jobs, and segments.
"""

from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum
from datetime import datetime


class SegmentType(str, Enum):
    """Type of personalization segment."""
    VOICE = "voice"          # Audio replacement with lip-sync
    TEXT = "text"            # On-screen text replacement
    IMAGE = "image"          # Logo/image replacement


class VoiceSegment(BaseModel):
    """A segment where voice/audio will be personalized."""
    id: str
    start_time: float                    # Start time in seconds
    end_time: float                      # End time in seconds
    template_text: str                   # Text with {placeholders}
    # Example: "Hello {client_name}, welcome to {company_name}!"


class VisualSegment(BaseModel):
    """A segment where visual elements will be replaced."""
    id: str
    segment_type: SegmentType            # TEXT or IMAGE
    start_time: float
    end_time: float
    # Bounding box in relative coordinates (0-1)
    x: float
    y: float
    width: float
    height: float
    # For text: style info; for image: placeholder identifier
    placeholder_key: str                 # Key in personalization data
    # Optional: tracking reference frame (if element moves)
    tracking_reference_frame: Optional[int] = None


class VideoTemplate(BaseModel):
    """
    Defines a base video and all personalizable segments.
    Created once per demo video, reused for all personalizations.
    """
    id: str
    name: str
    base_video_path: str                 # GCS path to original video
    voice_segments: list[VoiceSegment] = []
    visual_segments: list[VisualSegment] = []
    # Presenter's cloned voice ID (from ElevenLabs)
    voice_id: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class PersonalizationData(BaseModel):
    """
    The actual personalization values for a specific recipient.
    Keys must match placeholders in the template.
    """
    client_name: str
    company_name: Optional[str] = None
    # Dynamic fields - any additional personalization
    custom_fields: dict[str, str] = {}
    # For image replacements
    logo_url: Optional[str] = None


class JobStatus(str, Enum):
    """Status of a personalization job."""
    PENDING = "pending"
    PROCESSING = "processing"
    GENERATING_VOICE = "generating_voice"
    SYNCING_LIPS = "syncing_lips"
    REPLACING_VISUALS = "replacing_visuals"
    COMPOSING = "composing"
    COMPLETED = "completed"
    FAILED = "failed"


class PersonalizationJob(BaseModel):
    """
    A single personalization job - one video for one recipient.
    Stored in Firestore for tracking and retrieval.
    """
    id: str
    template_id: str
    personalization: PersonalizationData
    status: JobStatus = JobStatus.PENDING
    progress: int = 0                    # 0-100
    output_url: Optional[str] = None     # GCS URL when complete
    error_message: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
