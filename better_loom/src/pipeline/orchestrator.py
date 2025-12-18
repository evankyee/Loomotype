"""
Personalization Pipeline - Production Version

This is the main orchestrator that coordinates all modules:
1. Voice generation (ElevenLabs)
2. Lip-sync (Sync Labs)
3. Visual replacement (FFmpeg overlays)
4. Video composition (FFmpeg concat)

The key insight is the order of operations:
1. Process voice segments first (get audio)
2. Apply lip-sync (get video segments)
3. Compose video (splice segments)
4. Apply visual overlays (single pass at the end)
"""

import tempfile
import shutil
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from loguru import logger

from ..core.video_info import get_video_info
from ..voice.client import VoiceClient
from ..lipsync.synclabs import LipSyncEngine
from ..visual.overlays import OverlayEngine, ImageOverlay
from ..compose.composer import VideoComposer, ProcessedSegment


@dataclass
class VoiceSegmentConfig:
    """Configuration for a voice segment to personalize."""
    id: str
    start_time: float
    end_time: float
    template_text: str  # e.g., "Hello {client_name}!"


@dataclass
class VisualOverlayConfig:
    """Configuration for a visual overlay."""
    id: str
    type: str  # "text" or "image"
    x: float   # 0-1 relative
    y: float   # 0-1 relative
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    # For text
    text_template: Optional[str] = None  # e.g., "{client_name}"
    font_size: int = 48
    color: tuple = (255, 255, 255)
    # For image
    image_key: Optional[str] = None  # Key in personalization data


@dataclass
class TemplateConfig:
    """Full template configuration."""
    id: str
    name: str
    voice_id: str  # ElevenLabs voice ID
    voice_segments: list[VoiceSegmentConfig] = field(default_factory=list)
    visual_overlays: list[VisualOverlayConfig] = field(default_factory=list)


@dataclass
class PersonalizationData:
    """Data for personalizing a video."""
    client_name: str
    company_name: Optional[str] = None
    logo_url: Optional[str] = None
    custom_fields: dict = field(default_factory=dict)


class PersonalizationPipeline:
    """
    End-to-end video personalization pipeline.

    Usage:
        pipeline = PersonalizationPipeline()

        output_path = pipeline.personalize(
            video_path=Path("base_video.mp4"),
            template=template_config,
            data=PersonalizationData(
                client_name="Alice",
                company_name="Acme Corp",
            ),
            output_path=Path("output.mp4"),
        )
    """

    def __init__(
        self,
        elevenlabs_api_key: Optional[str] = None,
        synclabs_api_key: Optional[str] = None,
    ):
        self.voice_client = VoiceClient(api_key=elevenlabs_api_key)
        self.lipsync_engine = LipSyncEngine(api_key=synclabs_api_key)
        self.temp_dir = Path(tempfile.mkdtemp())

    def cleanup(self):
        """Clean up temporary files."""
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def personalize(
        self,
        video_path: Path,
        template: TemplateConfig,
        data: PersonalizationData,
        output_path: Path,
    ) -> Path:
        """
        Run the full personalization pipeline.

        Args:
            video_path: Path to base video
            template: Template configuration
            data: Personalization data
            output_path: Where to save the result

        Returns:
            Path to the personalized video
        """
        video_path = Path(video_path)
        output_path = Path(output_path)

        if not video_path.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")

        # Get video info for dimensions and duration
        video_info = get_video_info(video_path)
        logger.info(
            f"Starting personalization: {video_info.width}x{video_info.height}, "
            f"{video_info.duration:.2f}s"
        )

        try:
            # Step 1: Process voice segments
            processed_segments = []
            if template.voice_segments:
                processed_segments = self._process_voice_segments(
                    video_path=video_path,
                    voice_id=template.voice_id,
                    segments=template.voice_segments,
                    data=data,
                )

            # Step 2: Compose video with lip-synced segments
            if processed_segments:
                composed_path = self.temp_dir / "composed.mp4"
                self._compose_video(
                    original_video=video_path,
                    processed_segments=processed_segments,
                    output_path=composed_path,
                )
            else:
                composed_path = video_path

            # Step 3: Apply visual overlays
            if template.visual_overlays:
                self._apply_visual_overlays(
                    video_path=composed_path,
                    overlays=template.visual_overlays,
                    data=data,
                    video_width=video_info.width,
                    video_height=video_info.height,
                    output_path=output_path,
                )
            else:
                # No overlays, just copy or move
                if composed_path != video_path:
                    shutil.move(str(composed_path), str(output_path))
                else:
                    shutil.copy(str(video_path), str(output_path))

            logger.info(f"Personalization complete: {output_path}")
            return output_path

        except Exception as e:
            logger.exception("Personalization failed")
            raise

    def _process_voice_segments(
        self,
        video_path: Path,
        voice_id: str,
        segments: list[VoiceSegmentConfig],
        data: PersonalizationData,
    ) -> list[dict]:
        """
        Process all voice segments:
        1. Generate personalized audio
        2. Apply lip-sync
        3. Return processed segment info
        """
        results = []

        for i, segment in enumerate(segments):
            logger.info(f"Processing voice segment {i+1}/{len(segments)}: {segment.id}")

            # Fill template with data
            text = self._fill_template(segment.template_text, data)
            logger.debug(f"Text: {text}")

            # Calculate segment duration
            segment_duration = segment.end_time - segment.start_time

            # Step 1: Generate audio matched to segment duration
            audio_path = self.temp_dir / f"audio_{segment.id}.wav"
            self.voice_client.generate_for_segment(
                text=text,
                voice_id=voice_id,
                target_duration=segment_duration,
                output_path=audio_path,
            )

            # Step 2: Apply lip-sync
            lipsync_path = self.temp_dir / f"lipsync_{segment.id}.mp4"
            self.lipsync_engine.process_segment(
                video_path=video_path,
                audio_path=audio_path,
                start_time=segment.start_time,
                end_time=segment.end_time,
                output_path=lipsync_path,
            )

            results.append({
                "video_path": lipsync_path,
                "start_time": segment.start_time,
                "end_time": segment.end_time,
            })

        return results

    def _compose_video(
        self,
        original_video: Path,
        processed_segments: list[dict],
        output_path: Path,
    ):
        """Compose video with processed segments."""
        composer = VideoComposer()

        try:
            segments = [
                ProcessedSegment(
                    video_path=s["video_path"],
                    start_time=s["start_time"],
                    end_time=s["end_time"],
                )
                for s in processed_segments
            ]

            composer.compose(
                original_video=original_video,
                processed_segments=segments,
                output_path=output_path,
            )

        finally:
            composer.cleanup()

    def _apply_visual_overlays(
        self,
        video_path: Path,
        overlays: list[VisualOverlayConfig],
        data: PersonalizationData,
        video_width: int,
        video_height: int,
        output_path: Path,
    ):
        """Apply all visual overlays."""
        engine = OverlayEngine(temp_dir=self.temp_dir / "overlays")

        try:
            overlay_images = []

            for overlay in overlays:
                # Convert relative to pixel coordinates
                x = int(overlay.x * video_width)
                y = int(overlay.y * video_height)

                if overlay.type == "text":
                    if not overlay.text_template:
                        continue

                    text = self._fill_template(overlay.text_template, data)
                    img_overlay = engine.create_text_overlay(
                        text=text,
                        x=x,
                        y=y,
                        start_time=overlay.start_time,
                        end_time=overlay.end_time,
                        font_size=overlay.font_size,
                        color=overlay.color,
                    )
                    overlay_images.append(img_overlay)

                elif overlay.type == "image":
                    # Get image source from data
                    image_source = None
                    if overlay.image_key == "logo":
                        image_source = data.logo_url
                    elif overlay.image_key in data.custom_fields:
                        image_source = data.custom_fields[overlay.image_key]

                    if not image_source:
                        logger.warning(f"No image source for overlay {overlay.id}")
                        continue

                    img_overlay = engine.create_image_overlay(
                        image_source=image_source,
                        x=x,
                        y=y,
                        start_time=overlay.start_time,
                        end_time=overlay.end_time,
                    )
                    overlay_images.append(img_overlay)

            if overlay_images:
                engine.apply_overlays(
                    video_path=video_path,
                    overlays=overlay_images,
                    output_path=output_path,
                )
            else:
                shutil.copy(video_path, output_path)

        finally:
            engine.cleanup()

    def _fill_template(self, template: str, data: PersonalizationData) -> str:
        """Fill a template string with personalization data."""
        result = template

        # Standard fields
        result = result.replace("{client_name}", data.client_name)
        if data.company_name:
            result = result.replace("{company_name}", data.company_name)

        # Custom fields
        for key, value in data.custom_fields.items():
            result = result.replace(f"{{{key}}}", str(value))

        return result


# Convenience function
def personalize_video(
    video_path: str | Path,
    template: dict,
    data: dict,
    output_path: str | Path,
) -> Path:
    """
    Personalize a video using the provided template and data.

    Args:
        video_path: Path to base video
        template: Template configuration dict
        data: Personalization data dict
        output_path: Where to save result

    Returns:
        Path to personalized video
    """
    # Convert dicts to dataclasses
    template_config = TemplateConfig(
        id=template["id"],
        name=template["name"],
        voice_id=template["voice_id"],
        voice_segments=[
            VoiceSegmentConfig(**s) for s in template.get("voice_segments", [])
        ],
        visual_overlays=[
            VisualOverlayConfig(**o) for o in template.get("visual_overlays", [])
        ],
    )

    person_data = PersonalizationData(
        client_name=data["client_name"],
        company_name=data.get("company_name"),
        logo_url=data.get("logo_url"),
        custom_fields=data.get("custom_fields", {}),
    )

    pipeline = PersonalizationPipeline()

    try:
        return pipeline.personalize(
            video_path=Path(video_path),
            template=template_config,
            data=person_data,
            output_path=Path(output_path),
        )
    finally:
        pipeline.cleanup()
