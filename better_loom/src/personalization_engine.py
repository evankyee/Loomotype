"""
Soron Personalization Engine

Complete pipeline for video personalization:
1. Transcribe video with word-level timestamps (Google Chirp 3)
2. Detect objects/text in video (Google Vision)
3. Accept edits (transcript changes, visual replacements)
4. Generate new voice for transcript edits (ElevenLabs)
5. Apply lip-sync for voice changes (Sync Labs)
6. Apply visual replacements (FFmpeg)
7. Output final personalized video
"""

import tempfile
import shutil
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum

from loguru import logger

from .config import settings
from .transcription import GoogleSpeechClient, Transcript, TranscriptWord
from .vision import GoogleVisionClient, FrameAnalysis, DetectedObject, DetectedText
from .voice import VoiceClient
from .lipsync import SyncLabsClient
from .video import VideoCompositor, VisualReplacement, ReplacementType
from .video.compositor import AudioReplacer


class EditType(str, Enum):
    """Type of edit to apply."""
    TRANSCRIPT = "transcript"  # Change what is said (requires voice + lipsync)
    VISUAL = "visual"          # Change visual element


@dataclass
class TranscriptEdit:
    """An edit to the transcript."""
    start_time: float       # Start time in video
    end_time: float         # End time in video
    original_text: str      # Original text being replaced
    new_text: str           # New text to say

    # Generated assets (filled in during processing)
    generated_audio_path: Optional[Path] = None
    lipsynced_video_path: Optional[Path] = None


@dataclass
class VisualEdit:
    """An edit to visual elements."""
    x: float                # Normalized x (0-1)
    y: float                # Normalized y (0-1)
    width: float            # Normalized width (0-1)
    height: float           # Normalized height (0-1)
    start_time: float       # Start time
    end_time: float         # End time

    edit_type: ReplacementType  # TEXT, IMAGE, BLUR, REMOVE
    new_content: Optional[str] = None  # New text, image path, or color

    # For text replacements
    font_size: int = 48
    font_color: str = "white"
    background_color: Optional[str] = None


@dataclass
class PersonalizationJob:
    """A complete personalization job."""
    video_path: Path
    voice_id: Optional[str] = None  # ElevenLabs voice ID for TTS

    transcript: Optional[Transcript] = None
    frame_analyses: list[FrameAnalysis] = field(default_factory=list)

    transcript_edits: list[TranscriptEdit] = field(default_factory=list)
    visual_edits: list[VisualEdit] = field(default_factory=list)

    # Output
    output_path: Optional[Path] = None


class PersonalizationEngine:
    """
    Main engine for video personalization.

    Usage:
        engine = PersonalizationEngine()

        # Analyze video
        job = engine.analyze_video("input.mp4")

        # See what's in the video
        print(job.transcript)  # Word-by-word transcript
        print(job.frame_analyses)  # Detected objects, text, logos

        # Add edits
        job.transcript_edits.append(TranscriptEdit(
            start_time=5.0, end_time=8.0,
            original_text="Hello John",
            new_text="Hello Sarah"
        ))

        job.visual_edits.append(VisualEdit(
            x=0.1, y=0.1, width=0.2, height=0.1,
            start_time=0, end_time=10,
            edit_type=ReplacementType.TEXT,
            new_content="Acme Corp"
        ))

        # Generate personalized video
        output = engine.process(job, voice_id="your-voice-id")
    """

    def __init__(self):
        self.speech_client = GoogleSpeechClient()
        self.vision_client = GoogleVisionClient()
        self.voice_client = VoiceClient()
        self.lipsync_client = SyncLabsClient()

        self.temp_dir = Path(tempfile.mkdtemp(prefix="soron_"))

    def analyze_video(
        self,
        video_path: Path,
        transcribe: bool = True,
        detect_objects: bool = True,
        analysis_interval: float = 2.0,
    ) -> PersonalizationJob:
        """
        Analyze a video for personalization.

        Args:
            video_path: Path to video file
            transcribe: Whether to generate transcript
            detect_objects: Whether to detect objects/text
            analysis_interval: Seconds between frame analyses

        Returns:
            PersonalizationJob with analysis results
        """
        video_path = Path(video_path)
        job = PersonalizationJob(video_path=video_path)

        # Transcribe
        if transcribe:
            logger.info("Transcribing video with Google Chirp 3...")
            job.transcript = self.speech_client.transcribe_video(video_path)
            logger.info(f"Transcription complete: {len(job.transcript.segments)} segments")

            # Log transcript preview
            for seg in job.transcript.segments[:3]:
                logger.info(f"  [{seg.start_time:.1f}s - {seg.end_time:.1f}s] {seg.text[:50]}...")

        # Detect objects and text
        if detect_objects:
            logger.info("Analyzing video frames with Google Vision...")
            job.frame_analyses = self.vision_client.analyze_video_frames(
                video_path,
                interval_seconds=analysis_interval,
            )
            logger.info(f"Analyzed {len(job.frame_analyses)} frames")

            # Log detection summary
            all_objects = set()
            all_texts = set()
            for analysis in job.frame_analyses:
                for obj in analysis.objects:
                    all_objects.add(obj.name)
                for text in analysis.texts:
                    if len(text.text) > 2:  # Skip very short text
                        all_texts.add(text.text[:30])

            if all_objects:
                logger.info(f"  Objects detected: {', '.join(list(all_objects)[:10])}")
            if all_texts:
                logger.info(f"  Text detected: {', '.join(list(all_texts)[:5])}")

        return job

    def clone_voice_from_video(self, video_path: Path, name: str = "Cloned Voice") -> str:
        """
        Clone the speaker's voice from a video.

        Args:
            video_path: Path to video with speaker
            name: Name for the cloned voice

        Returns:
            Voice ID for use in TTS
        """
        import subprocess

        video_path = Path(video_path)

        # Extract audio
        audio_path = self.temp_dir / "voice_sample.wav"
        subprocess.run([
            "ffmpeg", "-y", "-i", str(video_path),
            "-ar", "44100", "-ac", "1",
            "-t", "60",  # First 60 seconds
            str(audio_path)
        ], check=True, capture_output=True)

        # Clone voice
        logger.info("Cloning voice from video...")
        voice_id = self.voice_client.clone_voice(name, [str(audio_path)])
        logger.info(f"Voice cloned: {voice_id}")

        return voice_id

    def process(
        self,
        job: PersonalizationJob,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Process a personalization job and generate output video.

        Args:
            job: PersonalizationJob with edits to apply
            output_path: Path for output video (optional)

        Returns:
            Path to personalized video
        """
        if not output_path:
            output_path = self.temp_dir / "output.mp4"

        output_path = Path(output_path)
        current_video = job.video_path

        # Step 1: Process transcript edits (voice + lipsync)
        if job.transcript_edits and job.voice_id:
            logger.info(f"Processing {len(job.transcript_edits)} transcript edits...")
            current_video = self._process_transcript_edits(job, current_video)

        # Step 2: Apply visual edits
        if job.visual_edits:
            logger.info(f"Applying {len(job.visual_edits)} visual edits...")
            current_video = self._apply_visual_edits(job, current_video, output_path)
        else:
            # Just copy if no visual edits
            if current_video != output_path:
                shutil.copy(current_video, output_path)

        job.output_path = output_path
        logger.info(f"Personalization complete: {output_path}")

        return output_path

    def _process_transcript_edits(
        self,
        job: PersonalizationJob,
        video_path: Path,
    ) -> Path:
        """Process transcript edits with voice generation and lip-sync."""
        current_video = video_path

        for i, edit in enumerate(job.transcript_edits):
            logger.info(f"Processing transcript edit {i+1}/{len(job.transcript_edits)}")
            logger.info(f"  '{edit.original_text}' -> '{edit.new_text}'")

            # Calculate target duration
            target_duration = edit.end_time - edit.start_time

            # Generate speech
            logger.info("  Generating speech...")
            audio_path = self.temp_dir / f"edit_{i}_audio.mp3"
            audio_path, _ = self.voice_client.generate(
                text=edit.new_text,
                voice_id=job.voice_id,
                output_path=audio_path,
            )

            # Time-stretch to match original duration
            from .voice import time_stretch_audio
            stretched_path = self.temp_dir / f"edit_{i}_stretched.mp3"
            time_stretch_audio(audio_path, stretched_path, target_duration)
            edit.generated_audio_path = stretched_path

            # Upload audio for lip-sync (need public URL)
            # For now, we'll use local processing approach

            # Extract the segment to lip-sync
            segment_path = self.temp_dir / f"edit_{i}_segment.mp4"
            self._extract_segment(current_video, edit.start_time, edit.end_time, segment_path)

            # Apply lip-sync
            logger.info("  Applying lip-sync...")
            try:
                lipsynced_path = self.temp_dir / f"edit_{i}_lipsynced.mp4"
                lipsynced_path = self.lipsync_client.lipsync(
                    video_path=segment_path,
                    audio_path=stretched_path,
                    output_path=lipsynced_path,
                    model="lipsync-2-pro",
                    max_wait_seconds=300,
                )
                edit.lipsynced_video_path = lipsynced_path
            except Exception as e:
                logger.warning(f"  Lip-sync failed: {e}, using audio-only replacement")
                edit.lipsynced_video_path = None

            # Replace segment in video
            if edit.lipsynced_video_path:
                # Replace video+audio segment
                output = self.temp_dir / f"video_after_edit_{i}.mp4"
                current_video = self._replace_segment(
                    current_video,
                    edit.lipsynced_video_path,
                    edit.start_time,
                    edit.end_time,
                    output,
                )
            else:
                # Replace audio only
                output = self.temp_dir / f"video_after_edit_{i}.mp4"
                AudioReplacer.replace_audio_segment(
                    current_video,
                    edit.generated_audio_path,
                    edit.start_time,
                    edit.end_time,
                    output,
                )
                current_video = output

        return current_video

    def _apply_visual_edits(
        self,
        job: PersonalizationJob,
        video_path: Path,
        output_path: Path,
    ) -> Path:
        """Apply visual replacements to video."""
        compositor = VideoCompositor(video_path)

        for edit in job.visual_edits:
            replacement = VisualReplacement(
                x=edit.x,
                y=edit.y,
                width=edit.width,
                height=edit.height,
                start_time=edit.start_time,
                end_time=edit.end_time,
                type=edit.edit_type,
                content=edit.new_content,
                font_size=edit.font_size,
                font_color=edit.font_color,
                background_color=edit.background_color,
            )
            compositor.add_replacement(replacement)

        return compositor.render(output_path)

    def _extract_segment(
        self,
        video_path: Path,
        start: float,
        end: float,
        output_path: Path,
    ):
        """Extract a segment from video."""
        import subprocess
        subprocess.run([
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-ss", str(start),
            "-to", str(end),
            "-c", "copy",
            str(output_path)
        ], check=True, capture_output=True)

    def _replace_segment(
        self,
        original: Path,
        replacement: Path,
        start: float,
        end: float,
        output: Path,
    ) -> Path:
        """Replace a segment in video with another video."""
        import subprocess

        # Get video duration
        result = subprocess.run([
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(original)
        ], capture_output=True, text=True)
        duration = float(result.stdout.strip())

        # Create concat list
        concat_file = self.temp_dir / "concat.txt"

        # Extract parts before and after
        before_path = self.temp_dir / "before.mp4"
        after_path = self.temp_dir / "after.mp4"

        # Before segment
        if start > 0:
            subprocess.run([
                "ffmpeg", "-y", "-i", str(original),
                "-t", str(start),
                "-c", "copy",
                str(before_path)
            ], check=True, capture_output=True)

        # After segment
        if end < duration:
            subprocess.run([
                "ffmpeg", "-y", "-i", str(original),
                "-ss", str(end),
                "-c", "copy",
                str(after_path)
            ], check=True, capture_output=True)

        # Build concat list
        parts = []
        if start > 0 and before_path.exists():
            parts.append(f"file '{before_path}'")
        parts.append(f"file '{replacement}'")
        if end < duration and after_path.exists():
            parts.append(f"file '{after_path}'")

        concat_file.write_text("\n".join(parts))

        # Concat
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_file),
            "-c", "copy",
            str(output)
        ], check=True, capture_output=True)

        return output

    def cleanup(self):
        """Clean up temporary files."""
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)


# Convenience function for simple personalization
def personalize_video(
    video_path: Path,
    transcript_edits: list[dict] = None,
    visual_edits: list[dict] = None,
    voice_id: str = None,
    output_path: Path = None,
) -> Path:
    """
    Simple interface for video personalization.

    Args:
        video_path: Input video path
        transcript_edits: List of dicts with start_time, end_time, original_text, new_text
        visual_edits: List of dicts with x, y, width, height, start_time, end_time, edit_type, new_content
        voice_id: ElevenLabs voice ID for transcript edits
        output_path: Output video path

    Returns:
        Path to personalized video
    """
    engine = PersonalizationEngine()

    try:
        # Analyze video
        job = engine.analyze_video(
            video_path,
            transcribe=bool(transcript_edits),
            detect_objects=bool(visual_edits),
        )

        job.voice_id = voice_id

        # Add transcript edits
        if transcript_edits:
            for edit in transcript_edits:
                job.transcript_edits.append(TranscriptEdit(**edit))

        # Add visual edits
        if visual_edits:
            for edit in visual_edits:
                edit_type = edit.pop("edit_type", "text")
                if isinstance(edit_type, str):
                    edit_type = ReplacementType(edit_type)
                job.visual_edits.append(VisualEdit(edit_type=edit_type, **edit))

        # Process
        return engine.process(job, output_path)

    finally:
        engine.cleanup()
