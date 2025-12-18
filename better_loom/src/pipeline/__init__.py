"""
Pipeline Module

Contains the main orchestration logic and supporting services.
"""

from .orchestrator import (
    PersonalizationPipeline,
    TemplateConfig,
    VoiceSegmentConfig,
    VisualOverlayConfig,
    PersonalizationData,
    personalize_video,
)

# Lazy imports for GCP services (not always needed)
def get_storage_client():
    """Get storage client (requires GCP configuration)."""
    from .storage import StorageClient
    return StorageClient()


def get_job_manager():
    """Get job manager (requires GCP configuration)."""
    from .jobs import JobManager
    return JobManager()


def get_template_manager():
    """Get template manager (requires GCP configuration)."""
    from .jobs import TemplateManager
    return TemplateManager()


__all__ = [
    "PersonalizationPipeline",
    "TemplateConfig",
    "VoiceSegmentConfig",
    "VisualOverlayConfig",
    "PersonalizationData",
    "personalize_video",
    "get_storage_client",
    "get_job_manager",
    "get_template_manager",
]
