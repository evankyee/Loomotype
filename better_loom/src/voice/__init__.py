"""
Voice Module

Uses ElevenLabs for voice cloning and text-to-speech with proper audio timing.
"""

from .client import VoiceClient, get_voice_client, generate_for_segment

__all__ = ["VoiceClient", "get_voice_client", "generate_for_segment"]
