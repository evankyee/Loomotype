"""Audio processing utilities for premium features."""

from .filler_detection import FillerDetector
from .pitch_matcher import (
    PitchMatcher,
    match_tts_to_original,
    is_pitch_matching_available,
)

__all__ = [
    "FillerDetector",
    "PitchMatcher",
    "match_tts_to_original",
    "is_pitch_matching_available",
]
