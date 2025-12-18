"""
Google Cloud Speech-to-Text with Chirp 3 model
Word-level timestamps for transcript editing
"""

import os
import subprocess
import tempfile
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

from google.cloud import speech_v2 as speech
from google.cloud.speech_v2.types import cloud_speech
from loguru import logger

from ..config import settings


@dataclass
class TranscriptWord:
    """A single word with timing information."""
    text: str
    start_time: float  # seconds
    end_time: float    # seconds
    confidence: float = 1.0
    speaker: Optional[int] = None


@dataclass
class TranscriptSegment:
    """A segment of speech (sentence/phrase)."""
    text: str
    start_time: float
    end_time: float
    words: list[TranscriptWord] = field(default_factory=list)
    speaker: Optional[int] = None


@dataclass
class Transcript:
    """Complete transcript with word-level timing."""
    segments: list[TranscriptSegment]
    duration: float
    language: str = "en-US"

    def get_words_in_range(self, start: float, end: float) -> list[TranscriptWord]:
        """Get all words within a time range."""
        words = []
        for segment in self.segments:
            for word in segment.words:
                if word.start_time >= start and word.end_time <= end:
                    words.append(word)
        return words

    def get_text_in_range(self, start: float, end: float) -> str:
        """Get text for a time range."""
        words = self.get_words_in_range(start, end)
        return " ".join(w.text for w in words)


class GoogleSpeechClient:
    """
    Google Cloud Speech-to-Text client using Chirp 3 model.

    Chirp 3 provides:
    - State-of-the-art accuracy
    - Word-level timestamps
    - Speaker diarization
    - 85+ languages
    - Built-in denoiser
    """

    def __init__(self, project_id: str = None, location: str = "northamerica-northeast1"):
        self.project_id = project_id or settings.gcp_project_id
        if not self.project_id:
            raise ValueError("GCP project ID required")

        # Chirp 3 is only available in specific regions:
        # asia-south1, europe-west2, europe-west3, northamerica-northeast1
        self.location = location

        # Configure client for regional endpoint
        from google.api_core.client_options import ClientOptions
        client_options = ClientOptions(
            api_endpoint=f"{location}-speech.googleapis.com"
        )
        self.client = speech.SpeechClient(client_options=client_options)
        self.parent = f"projects/{self.project_id}/locations/{self.location}"

        # Chirp 3 recognizer - create on first use
        self._recognizer_name = None

    def _get_or_create_recognizer(self) -> str:
        """Get or create a Chirp 3 recognizer."""
        if self._recognizer_name:
            return self._recognizer_name

        recognizer_id = "chirp3-recognizer"
        recognizer_name = f"{self.parent}/recognizers/{recognizer_id}"

        # Try to get existing recognizer
        try:
            self.client.get_recognizer(name=recognizer_name)
            self._recognizer_name = recognizer_name
            logger.info(f"Using existing recognizer: {recognizer_name}")
            return recognizer_name
        except Exception:
            pass

        # Create new recognizer with Chirp 3
        logger.info("Creating new Chirp 3 recognizer...")

        recognizer = cloud_speech.Recognizer(
            model="chirp_3",
            language_codes=["en-US"],
            default_recognition_config=cloud_speech.RecognitionConfig(
                features=cloud_speech.RecognitionFeatures(
                    enable_word_time_offsets=True,
                    enable_automatic_punctuation=True,
                    # Note: enable_word_confidence not supported by chirp_3
                ),
                auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
            ),
        )

        request = cloud_speech.CreateRecognizerRequest(
            parent=self.parent,
            recognizer_id=recognizer_id,
            recognizer=recognizer,
        )

        operation = self.client.create_recognizer(request=request)
        result = operation.result()

        self._recognizer_name = result.name
        logger.info(f"Created recognizer: {self._recognizer_name}")
        return self._recognizer_name

    def transcribe_file(
        self,
        audio_path: Path,
        language: str = "en-US",
        enable_diarization: bool = False,
        num_speakers: int = 1,
    ) -> Transcript:
        """
        Transcribe an audio file with word-level timestamps.

        Args:
            audio_path: Path to audio file (WAV, FLAC, MP3, etc.)
            language: Language code (e.g., "en-US")
            enable_diarization: Enable speaker diarization
            num_speakers: Expected number of speakers (if diarization enabled)

        Returns:
            Transcript with word-level timing
        """
        audio_path = Path(audio_path)

        # Convert to mono WAV if needed (Chirp 3 works best with WAV)
        wav_path = self._ensure_wav(audio_path)

        # Read audio content
        with open(wav_path, "rb") as f:
            audio_content = f.read()

        # Get recognizer
        recognizer = self._get_or_create_recognizer()

        # Build recognition config
        config = cloud_speech.RecognitionConfig(
            features=cloud_speech.RecognitionFeatures(
                enable_word_time_offsets=True,
                enable_automatic_punctuation=True,
                # Note: enable_word_confidence not supported by chirp_3
            ),
            auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
        )

        # Add diarization if requested
        if enable_diarization:
            config.features.diarization_config = cloud_speech.SpeakerDiarizationConfig(
                min_speaker_count=1,
                max_speaker_count=num_speakers,
            )

        # Create request
        request = cloud_speech.RecognizeRequest(
            recognizer=recognizer,
            config=config,
            content=audio_content,
        )

        logger.info(f"Transcribing {audio_path.name} with Chirp 3...")

        # Run recognition
        response = self.client.recognize(request=request)

        # Parse results into Transcript
        return self._parse_response(response, language)

    def transcribe_video(
        self,
        video_path: Path,
        language: str = "en-US",
        enable_diarization: bool = False,
        num_speakers: int = 1,
    ) -> Transcript:
        """
        Extract audio from video and transcribe.

        Args:
            video_path: Path to video file
            language: Language code
            enable_diarization: Enable speaker diarization
            num_speakers: Expected number of speakers

        Returns:
            Transcript with word-level timing
        """
        video_path = Path(video_path)

        # Extract audio from video
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            audio_path = Path(f.name)

        logger.info(f"Extracting audio from {video_path.name}...")

        subprocess.run([
            "ffmpeg", "-y", "-i", str(video_path),
            "-ar", "16000",  # 16kHz sample rate (recommended for Chirp)
            "-ac", "1",      # Mono
            "-c:a", "pcm_s16le",  # 16-bit PCM
            str(audio_path)
        ], check=True, capture_output=True)

        try:
            return self.transcribe_file(
                audio_path,
                language=language,
                enable_diarization=enable_diarization,
                num_speakers=num_speakers,
            )
        finally:
            # Cleanup temp file
            audio_path.unlink(missing_ok=True)

    def _ensure_wav(self, audio_path: Path) -> Path:
        """Convert audio to WAV format if needed."""
        if audio_path.suffix.lower() == ".wav":
            return audio_path

        wav_path = audio_path.with_suffix(".wav")

        subprocess.run([
            "ffmpeg", "-y", "-i", str(audio_path),
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            str(wav_path)
        ], check=True, capture_output=True)

        return wav_path

    def _parse_response(
        self,
        response: cloud_speech.RecognizeResponse,
        language: str,
    ) -> Transcript:
        """Parse Speech-to-Text response into Transcript."""
        segments = []
        total_duration = 0.0

        for result in response.results:
            if not result.alternatives:
                continue

            alt = result.alternatives[0]

            # Build words list
            words = []
            for word_info in alt.words:
                start = word_info.start_offset.total_seconds()
                end = word_info.end_offset.total_seconds()

                word = TranscriptWord(
                    text=word_info.word,
                    start_time=start,
                    end_time=end,
                    confidence=word_info.confidence if word_info.confidence else 1.0,
                    speaker=word_info.speaker_label if hasattr(word_info, 'speaker_label') else None,
                )
                words.append(word)
                total_duration = max(total_duration, end)

            # Create segment
            if words:
                segment = TranscriptSegment(
                    text=alt.transcript,
                    start_time=words[0].start_time,
                    end_time=words[-1].end_time,
                    words=words,
                )
                segments.append(segment)

        return Transcript(
            segments=segments,
            duration=total_duration,
            language=language,
        )


# Convenience function
def transcribe_video(
    video_path: Path,
    language: str = "en-US",
    enable_diarization: bool = False,
) -> Transcript:
    """Transcribe a video file using Google Chirp 3."""
    client = GoogleSpeechClient()
    return client.transcribe_video(video_path, language, enable_diarization)
