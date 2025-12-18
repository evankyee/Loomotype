"""
ElevenLabs Voice Client - Production Version

Handles voice cloning and text-to-speech with proper audio timing.
"""

import os
import tempfile
from pathlib import Path
from loguru import logger
from typing import Optional

from elevenlabs.client import ElevenLabs
from elevenlabs import VoiceSettings

from ..core.ffmpeg_utils import FFmpegProcessor
from ..core.video_info import get_audio_duration


class VoiceClient:
    """
    Production voice client using ElevenLabs.

    Key feature: generate_for_segment() ensures audio matches
    the original segment duration for perfect sync.
    """

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize with API key from parameter or environment.
        """
        self.api_key = api_key or os.getenv("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ValueError(
                "ElevenLabs API key required. "
                "Set ELEVENLABS_API_KEY environment variable."
            )

        self.client = ElevenLabs(api_key=self.api_key)
        self.model_id = "eleven_multilingual_v2"

    def clone_voice(
        self,
        name: str,
        audio_files: list[str | Path],
        description: str = "Cloned presenter voice",
    ) -> str:
        """
        Clone a voice from audio samples.

        Args:
            name: Name for the cloned voice
            audio_files: List of paths to audio samples (30+ minutes recommended)
            description: Description for the voice

        Returns:
            voice_id to use for generation
        """
        logger.info(f"Cloning voice '{name}' from {len(audio_files)} files")

        # Verify audio files exist and open them
        file_handles = []
        try:
            for path in audio_files:
                path = Path(path)
                if not path.exists():
                    raise FileNotFoundError(f"Audio file not found: {path}")
                # Open file in binary mode for upload
                file_handles.append(open(path, "rb"))
                logger.info(f"Opened audio file: {path} ({path.stat().st_size} bytes)")

            # Create voice clone using new SDK method (voices.ivc.create)
            # The new ElevenLabs SDK uses client.voices.ivc.create() for instant voice cloning
            voice = self.client.voices.ivc.create(
                name=name,
                description=description,
                files=file_handles,
            )

            logger.info(f"Voice cloned: {voice.voice_id}")
            return voice.voice_id
        finally:
            # Close all file handles
            for fh in file_handles:
                fh.close()

    def generate(
        self,
        text: str,
        voice_id: str,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Generate speech from text.

        Args:
            text: Text to speak
            voice_id: ElevenLabs voice ID
            output_path: Where to save (optional, creates temp file)

        Returns:
            Path to generated audio file (WAV format)
        """
        logger.debug(f"Generating: '{text[:50]}...'")

        # Generate with ElevenLabs using high-quality settings
        # Higher stability = more consistent, less variation (good for dubbing)
        # Higher similarity_boost = closer to original voice
        audio_generator = self.client.text_to_speech.convert(
            text=text,
            voice_id=voice_id,
            model_id=self.model_id,
            voice_settings=VoiceSettings(
                stability=0.7,  # Higher for more consistent dubbing
                similarity_boost=0.85,  # High for voice matching
                style=0.0,  # No style exaggeration
                use_speaker_boost=True,
            ),
            output_format="pcm_24000",  # Uncompressed PCM at 24kHz (available on current plan)
        )

        # Collect audio bytes (PCM is raw 16-bit signed little-endian)
        audio_bytes = b"".join(audio_generator)

        # Convert to WAV for processing
        if output_path is None:
            fd, output_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            output_path = Path(output_path)

        # Save raw PCM to temp file
        with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as f:
            f.write(audio_bytes)
            temp_pcm = Path(f.name)

        # Convert raw PCM to WAV with proper headers
        # Keep at native 24kHz - downstream composition will resample to 48kHz
        from ..core.ffmpeg_utils import run_ffmpeg
        run_ffmpeg([
            "-f", "s16le",    # Input format: signed 16-bit little-endian
            "-ar", "24000",   # Input sample rate: 24kHz from ElevenLabs
            "-ac", "1",       # Input channels: mono
            "-i", str(temp_pcm),
            "-acodec", "pcm_s16le",
            "-ar", "24000",   # Output at native 24kHz (composition will resample to 48kHz)
            str(output_path),
        ], "Convert PCM to WAV")

        # Clean up temp PCM
        temp_pcm.unlink()

        logger.debug(f"Generated audio: {output_path}")
        return output_path

    def generate_for_segment(
        self,
        text: str,
        voice_id: str,
        target_duration: float,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Generate speech that matches a specific duration.

        This is the key method for video personalization.
        It generates speech then time-stretches to match exactly.

        Args:
            text: Text to speak
            voice_id: ElevenLabs voice ID
            target_duration: Duration in seconds to match
            output_path: Where to save final audio

        Returns:
            Path to audio file with exact target duration
        """
        logger.info(f"Generating speech for {target_duration:.2f}s segment: '{text}'")

        # Generate raw audio
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            raw_audio = Path(f.name)

        self.generate(text, voice_id, raw_audio)

        # Check duration
        raw_duration = get_audio_duration(raw_audio)
        logger.debug(f"Raw audio duration: {raw_duration:.2f}s, target: {target_duration:.2f}s")

        # Prepare output path
        if output_path is None:
            fd, output_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            output_path = Path(output_path)

        # Time-stretch to match target duration
        FFmpegProcessor.time_stretch_audio(
            audio_path=raw_audio,
            target_duration=target_duration,
            output_path=output_path,
        )

        # Clean up
        raw_audio.unlink()

        # Verify final duration
        final_duration = get_audio_duration(output_path)
        logger.info(
            f"Generated audio: {final_duration:.2f}s "
            f"(target: {target_duration:.2f}s, diff: {abs(final_duration - target_duration)*1000:.1f}ms)"
        )

        return output_path

    def list_voices(self) -> list[dict]:
        """List all available voices including clones."""
        response = self.client.voices.get_all()
        return [
            {
                "id": v.voice_id,
                "name": v.name,
                "category": v.category,
            }
            for v in response.voices
        ]

    def delete_voice(self, voice_id: str):
        """Delete a cloned voice."""
        self.client.voices.delete(voice_id)
        logger.info(f"Deleted voice: {voice_id}")


# Module-level convenience functions
_client: Optional[VoiceClient] = None


def get_voice_client() -> VoiceClient:
    """Get or create the voice client singleton."""
    global _client
    if _client is None:
        _client = VoiceClient()
    return _client


def generate_for_segment(
    text: str,
    voice_id: str,
    target_duration: float,
    output_path: Optional[Path] = None,
) -> Path:
    """Generate speech matching a specific duration."""
    return get_voice_client().generate_for_segment(
        text, voice_id, target_duration, output_path
    )
