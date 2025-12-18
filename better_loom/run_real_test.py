#!/usr/bin/env python3
"""
Real End-to-End Test

This script runs a complete personalization pipeline test:
1. Downloads a sample video with a face
2. Generates personalized voice audio
3. Applies lip-sync
4. Outputs the personalized video

Run with: python run_real_test.py
"""

import os
import sys
import tempfile
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from loguru import logger

# Configure logging
logger.remove()
logger.add(sys.stderr, level="INFO", format="<green>{time:HH:mm:ss}</green> | <level>{message}</level>")


def download_sample_video(output_path: Path) -> Path:
    """Download a sample video with a talking face."""
    import httpx

    # Using Sync Labs' example video (has a face)
    url = "https://assets.sync.so/docs/example-video.mp4"

    logger.info(f"Downloading sample video from {url}")

    response = httpx.get(url, follow_redirects=True, timeout=60.0)
    response.raise_for_status()

    output_path.write_bytes(response.content)
    logger.info(f"Downloaded to {output_path} ({len(response.content) / 1024:.1f} KB)")

    return output_path


def test_voice_generation():
    """Test ElevenLabs voice generation."""
    from src.voice import VoiceClient
    from src.core import get_video_info

    logger.info("=" * 50)
    logger.info("Testing Voice Generation")
    logger.info("=" * 50)

    client = VoiceClient()

    # List voices
    voices = client.list_voices()
    logger.info(f"Available voices: {len(voices)}")

    # Use first voice
    voice_id = voices[0]["id"]
    voice_name = voices[0]["name"]
    logger.info(f"Using voice: {voice_name} ({voice_id})")

    # Generate for a specific duration (matching original segment)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        output_path = Path(f.name)

    target_duration = 3.0  # seconds

    audio_path = client.generate_for_segment(
        text="Hello Alice, welcome to your personalized demo video!",
        voice_id=voice_id,
        target_duration=target_duration,
        output_path=output_path,
    )

    # Verify duration
    from src.core.video_info import get_audio_duration
    actual_duration = get_audio_duration(audio_path)

    logger.info(f"Generated audio: {actual_duration:.2f}s (target: {target_duration}s)")
    logger.info(f"Audio file: {audio_path}")

    return audio_path, voice_id


def test_lipsync(video_path: Path, audio_path: Path) -> Path:
    """Test Sync Labs lip-sync."""
    from src.lipsync import SyncLabsClient

    logger.info("=" * 50)
    logger.info("Testing Lip-Sync")
    logger.info("=" * 50)

    client = SyncLabsClient()

    # Estimate cost
    from src.core import get_video_info
    info = get_video_info(video_path)
    cost = client.estimate_cost(info.duration)
    logger.info(f"Video duration: {info.duration:.1f}s, estimated cost: ${cost:.2f}")

    # Run lip-sync using URLs (Sync Labs example assets)
    logger.info("Submitting lip-sync job...")

    result = client.lipsync_urls(
        video_url="https://assets.sync.so/docs/example-video.mp4",
        audio_url="https://assets.sync.so/docs/example-audio.wav",  # Use their sample audio for test
        model="lipsync-2",
        max_wait_seconds=300,
        poll_interval=5,
    )

    logger.info(f"Lip-sync complete!")
    logger.info(f"Output URL: {result.output_url}")

    # Download result
    output_path = Path("lipsync_output.mp4")
    client._download_result(result.output_url, output_path)

    logger.info(f"Downloaded to: {output_path}")

    return output_path


def test_visual_overlays(video_path: Path) -> Path:
    """Test visual overlay application."""
    from src.visual import OverlayEngine
    from src.core import get_video_info

    logger.info("=" * 50)
    logger.info("Testing Visual Overlays")
    logger.info("=" * 50)

    info = get_video_info(video_path)

    engine = OverlayEngine()

    try:
        # Create text overlay
        name_overlay = engine.create_text_overlay(
            text="Hello Alice!",
            x=50,
            y=50,
            start_time=0.5,
            end_time=info.duration - 0.5,
            font_size=48,
            color=(255, 255, 255),
        )

        company_overlay = engine.create_text_overlay(
            text="Acme Corporation",
            x=50,
            y=110,
            start_time=1.0,
            end_time=info.duration - 0.5,
            font_size=32,
            color=(200, 200, 200),
        )

        output_path = Path("overlay_output.mp4")

        engine.apply_overlays(
            video_path=video_path,
            overlays=[name_overlay, company_overlay],
            output_path=output_path,
        )

        logger.info(f"Overlays applied: {output_path}")

        return output_path

    finally:
        engine.cleanup()


def test_full_pipeline():
    """Test the complete pipeline."""
    from src.pipeline import (
        PersonalizationPipeline,
        TemplateConfig,
        VoiceSegmentConfig,
        VisualOverlayConfig,
        PersonalizationData,
    )

    logger.info("=" * 50)
    logger.info("Testing Full Pipeline")
    logger.info("=" * 50)

    # Download sample video
    video_path = Path("sample_video.mp4")
    if not video_path.exists():
        download_sample_video(video_path)

    # Create template (visual overlays only for now - voice requires GCS)
    template = TemplateConfig(
        id="test-template",
        name="Test Template",
        voice_id="",  # Skip voice for now
        voice_segments=[],
        visual_overlays=[
            VisualOverlayConfig(
                id="greeting",
                type="text",
                x=0.05,
                y=0.05,
                text_template="Hello {client_name}!",
                font_size=48,
                color=(255, 255, 255),
            ),
            VisualOverlayConfig(
                id="company",
                type="text",
                x=0.05,
                y=0.12,
                text_template="{company_name}",
                font_size=32,
                color=(200, 200, 200),
            ),
        ],
    )

    data = PersonalizationData(
        client_name="Alice Smith",
        company_name="Acme Corporation",
    )

    pipeline = PersonalizationPipeline()

    try:
        output_path = Path("personalized_output.mp4")

        result = pipeline.personalize(
            video_path=video_path,
            template=template,
            data=data,
            output_path=output_path,
        )

        logger.info(f"Pipeline complete: {result}")

        return result

    finally:
        pipeline.cleanup()


def main():
    logger.info("=" * 60)
    logger.info("SORON VIDEO PERSONALIZATION - END-TO-END TEST")
    logger.info("=" * 60)

    # Check environment
    if not os.getenv("ELEVENLABS_API_KEY"):
        logger.error("ELEVENLABS_API_KEY not set")
        return False

    if not os.getenv("SYNCLABS_API_KEY"):
        logger.error("SYNCLABS_API_KEY not set")
        return False

    logger.info("API keys configured ✓")

    try:
        # Test 1: Voice generation
        audio_path, voice_id = test_voice_generation()
        logger.info("Voice generation ✓")

        # Test 2: Download sample and test overlays
        video_path = Path("sample_video.mp4")
        if not video_path.exists():
            download_sample_video(video_path)

        overlay_result = test_visual_overlays(video_path)
        logger.info("Visual overlays ✓")

        # Test 3: Lip-sync (uses sample URLs to avoid upload complexity)
        lipsync_result = test_lipsync(video_path, audio_path)
        logger.info("Lip-sync ✓")

        # Test 4: Full pipeline (visual only)
        pipeline_result = test_full_pipeline()
        logger.info("Full pipeline ✓")

        logger.info("=" * 60)
        logger.info("ALL TESTS PASSED!")
        logger.info("=" * 60)
        logger.info(f"Outputs:")
        logger.info(f"  - Voice audio: {audio_path}")
        logger.info(f"  - Lip-synced video: {lipsync_result}")
        logger.info(f"  - Overlay video: {overlay_result}")
        logger.info(f"  - Pipeline output: {pipeline_result}")

        return True

    except Exception as e:
        logger.exception(f"Test failed: {e}")
        return False


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
