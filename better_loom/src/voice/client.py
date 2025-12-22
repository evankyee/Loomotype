"""
ElevenLabs Voice Client - Production Version (Pro Plan)

Handles voice cloning and text-to-speech with proper audio timing.
Supports both IVC (Instant) and PVC (Professional) voice cloning.
"""

import os
import hashlib
import tempfile
from pathlib import Path
from loguru import logger
from typing import Optional, Literal

from elevenlabs.client import ElevenLabs
from elevenlabs import VoiceSettings

from ..core.ffmpeg_utils import FFmpegProcessor
from ..core.video_info import get_audio_duration


# Global TTS cache: hash(text + voice_id) -> (audio_path, duration)
# Prevents regenerating the same audio for repeated requests
_tts_cache: dict[str, tuple[Path, float]] = {}
_tts_cache_dir: Optional[Path] = None


def _get_tts_cache_dir() -> Path:
    """Get or create the TTS cache directory."""
    global _tts_cache_dir
    if _tts_cache_dir is None:
        _tts_cache_dir = Path(tempfile.gettempdir()) / "soron" / "tts_cache"
        _tts_cache_dir.mkdir(parents=True, exist_ok=True)
    return _tts_cache_dir


def _get_cache_key(text: str, voice_id: str) -> str:
    """Generate cache key from text and voice_id."""
    content = f"{voice_id}:{text}"
    return hashlib.sha256(content.encode()).hexdigest()[:16]


class VoiceClient:
    """
    Production voice client using ElevenLabs Pro.

    Features:
    - IVC (Instant Voice Cloning) - Quick clones from short samples
    - PVC (Professional Voice Cloning) - High-quality clones from longer samples
    - 44.1kHz audio output (highest quality)
    - Optimized voice settings for dubbing/lip-sync
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

        # Pro plan: Use highest quality output (44.1kHz PCM)
        self.output_format = "pcm_44100"
        self.sample_rate = 44100

    def clone_voice(
        self,
        name: str,
        audio_files: list[str | Path],
        description: str = "Cloned presenter voice",
        method: Literal["ivc", "pvc", "auto"] = "auto",
    ) -> str:
        """
        Clone a voice from audio samples.

        Args:
            name: Name for the cloned voice
            audio_files: List of paths to audio samples
            description: Description for the voice
            method: "ivc" for Instant Voice Cloning (quick, works with 10-90s samples)
                    "pvc" for Professional Voice Cloning (highest quality, requires 30s+ audio)
                    "auto" to automatically choose based on audio duration (default)

        Returns:
            voice_id to use for generation
        """
        # Calculate total audio duration to determine best method
        total_duration = 0.0
        for path in audio_files:
            path = Path(path)
            if path.exists():
                try:
                    total_duration += get_audio_duration(path)
                except Exception as e:
                    logger.warning(f"Could not get duration for {path}: {e}")

        logger.info(f"Total audio duration: {total_duration:.1f}s")

        # Auto-select method based on duration
        # PVC requires at least 30 seconds, IVC works with 10-90 seconds
        if method == "auto":
            if total_duration >= 30:
                method = "pvc"
                logger.info("Auto-selected PVC (audio >= 30s)")
            else:
                method = "ivc"
                logger.info(f"Auto-selected IVC (audio {total_duration:.1f}s < 30s minimum for PVC)")
        elif method == "pvc" and total_duration < 30:
            logger.warning(f"PVC requested but audio only {total_duration:.1f}s (minimum 30s). Falling back to IVC.")
            method = "ivc"

        logger.info(f"Cloning voice '{name}' using {method.upper()} from {len(audio_files)} files")

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

            if method == "pvc":
                # Professional Voice Cloning - highest quality (Pro plan required)
                # New SDK requires 3-step process: create → upload samples → train
                logger.info("Using Professional Voice Cloning (PVC) for highest quality")

                try:
                    # Step 1: Create the voice entry
                    voice = self.client.voices.pvc.create(
                        name=name,
                        language="en",  # Required parameter
                        description=description,
                    )
                    voice_id = voice.voice_id
                    logger.info(f"PVC voice created: {voice_id}")

                    # Step 2: Upload audio samples
                    logger.info(f"Uploading {len(file_handles)} audio samples...")
                    self.client.voices.pvc.samples.create(
                        voice_id=voice_id,
                        files=file_handles,
                    )
                    logger.info("Audio samples uploaded successfully")

                    # Step 3: Start training (may be automatic in some SDK versions)
                    try:
                        self.client.voices.pvc.train(voice_id=voice_id)
                        logger.info("PVC training initiated")
                    except Exception as e:
                        # Training might auto-start or not be needed
                        logger.debug(f"Training call result: {e}")

                    logger.info(f"PVC voice cloned successfully: {voice_id}")
                    return voice_id

                except Exception as e:
                    error_str = str(e).lower()
                    # Check for voice_too_short or similar errors - fall back to IVC
                    if "voice_too_short" in error_str or "30 seconds" in error_str or "too short" in error_str:
                        logger.warning(f"PVC failed due to short audio: {e}. Falling back to IVC.")
                        # Reset file handles for retry
                        for fh in file_handles:
                            fh.seek(0)
                        # Continue to IVC below
                    else:
                        raise  # Re-raise other errors

            # Instant Voice Cloning - quick clones in seconds (single step)
            # Also used as fallback when PVC fails due to short audio
            logger.info("Using Instant Voice Cloning (IVC) for quick clone")
            voice = self.client.voices.ivc.create(
                name=name,
                description=description,
                files=file_handles,
            )
            logger.info(f"IVC voice cloned successfully: {voice.voice_id}")
            return voice.voice_id
        finally:
            # Close all file handles
            for fh in file_handles:
                fh.close()

    def clone_voice_pvc(
        self,
        name: str,
        audio_files: list[str | Path],
        description: str = "Professional cloned voice",
    ) -> str:
        """
        Create a Professional Voice Clone (highest quality).

        PVC creates the ultimate digital replica of your voice.
        Requires Pro plan. Best results with 30+ minutes of clean audio.

        Args:
            name: Name for the cloned voice
            audio_files: List of paths to audio samples (more = better quality)
            description: Description for the voice

        Returns:
            voice_id to use for generation
        """
        return self.clone_voice(name, audio_files, description, method="pvc")

    def clone_voice_ivc(
        self,
        name: str,
        audio_files: list[str | Path],
        description: str = "Instant cloned voice",
    ) -> str:
        """
        Create an Instant Voice Clone (quick, good quality).

        IVC creates voice clones in seconds from short samples.
        Works well with 60-90 seconds of audio.

        Args:
            name: Name for the cloned voice
            audio_files: List of paths to audio samples
            description: Description for the voice

        Returns:
            voice_id to use for generation
        """
        return self.clone_voice(name, audio_files, description, method="ivc")

    def generate(
        self,
        text: str,
        voice_id: str,
        output_path: Optional[Path] = None,
        use_cache: bool = True,
        previous_text: Optional[str] = None,
        next_text: Optional[str] = None,
    ) -> Path:
        """
        Generate speech from text with caching and context for natural prosody.

        Args:
            text: Text to speak
            voice_id: ElevenLabs voice ID
            output_path: Where to save (optional, creates temp file)
            use_cache: Whether to use TTS cache (default True)
            previous_text: Text that comes BEFORE this segment (for prosody matching)
            next_text: Text that comes AFTER this segment (for prosody matching)

        Returns:
            Path to generated audio file (WAV format)

        Note:
            previous_text and next_text are CRITICAL for natural-sounding word
            replacement. Without them, each segment is generated in isolation
            and sounds disconnected. With them, ElevenLabs matches the intonation
            and prosody to create seamless transitions.
        """
        # Include context in cache key if provided (different context = different prosody)
        cache_content = f"{voice_id}:{text}"
        if previous_text:
            cache_content += f"|prev:{previous_text}"
        if next_text:
            cache_content += f"|next:{next_text}"
        cache_key = hashlib.sha256(cache_content.encode()).hexdigest()[:16]

        if use_cache and cache_key in _tts_cache:
            cached_path, _ = _tts_cache[cache_key]
            if cached_path.exists():
                logger.debug(f"TTS cache hit: '{text[:30]}...'")
                if output_path:
                    import shutil
                    shutil.copy(cached_path, output_path)
                    return output_path
                return cached_path

        # Log context for debugging
        context_info = ""
        if previous_text:
            context_info += f" [prev: '{previous_text[-20:]}...']"
        if next_text:
            context_info += f" [next: '...{next_text[:20]}']"
        logger.debug(f"Generating: '{text[:50]}...'{context_info}")

        # Generate with ElevenLabs Pro using highest quality settings
        # Higher stability = more consistent, less variation (good for dubbing)
        # Higher similarity_boost = closer to original voice
        # previous_text/next_text = CRITICAL for matching prosody to surrounding speech
        audio_generator = self.client.text_to_speech.convert(
            text=text,
            voice_id=voice_id,
            model_id=self.model_id,
            voice_settings=VoiceSettings(
                stability=0.75,  # Slightly higher for consistent dubbing
                similarity_boost=0.9,  # Very high for best voice matching (Pro quality)
                style=0.0,  # No style exaggeration
                use_speaker_boost=True,  # Enhanced clarity
            ),
            output_format=self.output_format,  # 44.1kHz PCM (highest quality, Pro plan)
            previous_text=previous_text,  # Text before this segment for prosody matching
            next_text=next_text,  # Text after this segment for prosody matching
        )

        # Collect audio bytes (PCM is raw 16-bit signed little-endian)
        audio_bytes = b"".join(audio_generator)

        # Determine output path - use cache dir if caching
        if output_path is None:
            if use_cache:
                cache_dir = _get_tts_cache_dir()
                output_path = cache_dir / f"{cache_key}.wav"
            else:
                fd, output_path = tempfile.mkstemp(suffix=".wav")
                os.close(fd)
                output_path = Path(output_path)

        # Save raw PCM to temp file
        with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as f:
            f.write(audio_bytes)
            temp_pcm = Path(f.name)

        # Convert raw PCM to WAV with proper headers
        # Use 44.1kHz (highest quality from Pro plan)
        from ..core.ffmpeg_utils import run_ffmpeg
        run_ffmpeg([
            "-f", "s16le",    # Input format: signed 16-bit little-endian
            "-ar", str(self.sample_rate),  # Input sample rate: 44.1kHz from ElevenLabs Pro
            "-ac", "1",       # Input channels: mono
            "-i", str(temp_pcm),
            "-acodec", "pcm_s16le",
            "-ar", str(self.sample_rate),  # Output at native 44.1kHz (highest quality)
            str(output_path),
        ], "Convert PCM to WAV")

        # Cache the result
        if use_cache:
            duration = get_audio_duration(output_path)
            _tts_cache[cache_key] = (output_path, duration)
            logger.debug(f"TTS cached: '{text[:30]}...' ({duration:.2f}s)")

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
