#!/usr/bin/env python3
"""
Test Script for Personalized Video Pipeline

This script validates that all modules work together end-to-end.
Run with: python test_pipeline.py

Environment variables needed:
- ELEVENLABS_API_KEY: For voice generation
- SYNCLABS_API_KEY: For lip-sync (optional, tests will skip if not set)

For full cloud testing:
- GCP_PROJECT_ID: GCP project
- GCS_BUCKET: Storage bucket
"""

import sys
import os
import tempfile
import subprocess
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from loguru import logger


def check_ffmpeg():
    """Verify FFmpeg is installed."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            version = result.stdout.split("\n")[0]
            logger.info(f"✓ FFmpeg: {version}")
            return True
    except FileNotFoundError:
        pass

    logger.error("✗ FFmpeg not found. Install with: brew install ffmpeg")
    return False


def check_ffprobe():
    """Verify ffprobe is installed."""
    try:
        result = subprocess.run(
            ["ffprobe", "-version"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            logger.info("✓ ffprobe available")
            return True
    except FileNotFoundError:
        pass

    logger.error("✗ ffprobe not found")
    return False


def test_imports():
    """Test that all modules can be imported."""
    logger.info("Testing imports...")

    errors = []

    try:
        from src.core import FFmpegProcessor, VideoInfo, get_video_info
        logger.info("✓ Core module imports")
    except Exception as e:
        errors.append(f"Core: {e}")

    try:
        from src.voice import VoiceClient
        logger.info("✓ Voice module imports")
    except Exception as e:
        errors.append(f"Voice: {e}")

    try:
        from src.lipsync import LipSyncEngine, SyncLabsClient
        logger.info("✓ Lipsync module imports")
    except Exception as e:
        errors.append(f"Lipsync: {e}")

    try:
        from src.visual import OverlayEngine, ImageOverlay
        logger.info("✓ Visual module imports")
    except Exception as e:
        errors.append(f"Visual: {e}")

    try:
        from src.compose import VideoComposer
        logger.info("✓ Compose module imports")
    except Exception as e:
        errors.append(f"Compose: {e}")

    try:
        from src.pipeline import (
            PersonalizationPipeline,
            TemplateConfig,
            PersonalizationData,
        )
        logger.info("✓ Pipeline module imports")
    except Exception as e:
        errors.append(f"Pipeline: {e}")

    if errors:
        for err in errors:
            logger.error(f"✗ Import error: {err}")
        return False

    return True


def create_test_video(output_path: Path, duration: float = 5.0) -> Path:
    """Create a simple test video with FFmpeg."""
    logger.info(f"Creating test video: {duration}s")

    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi",
        "-i", f"color=c=blue:s=1280x720:d={duration}",
        "-f", "lavfi",
        "-i", f"sine=frequency=440:duration={duration}",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        str(output_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        logger.error(f"Failed to create test video: {result.stderr}")
        raise RuntimeError("Could not create test video")

    logger.info(f"✓ Test video created: {output_path}")
    return output_path


def test_video_info():
    """Test video info extraction."""
    logger.info("Testing video info extraction...")

    from src.core import get_video_info

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = Path(tmpdir) / "test.mp4"
        create_test_video(video_path, duration=3.0)

        info = get_video_info(video_path)

        assert info.width == 1280, f"Expected width 1280, got {info.width}"
        assert info.height == 720, f"Expected height 720, got {info.height}"
        assert 2.9 < info.duration < 3.1, f"Expected ~3s duration, got {info.duration}"

        logger.info(f"✓ Video info: {info.width}x{info.height}, {info.duration:.2f}s")

    return True


def test_ffmpeg_operations():
    """Test FFmpeg processing operations."""
    logger.info("Testing FFmpeg operations...")

    from src.core import FFmpegProcessor, get_video_info

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create test video
        video_path = tmpdir / "original.mp4"
        create_test_video(video_path, duration=10.0)

        # Test segment extraction
        segment_path = tmpdir / "segment.mp4"
        FFmpegProcessor.extract_segment(
            video_path=video_path,
            start_time=2.0,
            end_time=5.0,
            output_path=segment_path,
            reencode=True,
        )

        segment_info = get_video_info(segment_path)
        assert 2.8 < segment_info.duration < 3.2, f"Segment duration: {segment_info.duration}"
        logger.info(f"✓ Segment extraction: {segment_info.duration:.2f}s")

        # Test audio extraction
        audio_path = tmpdir / "audio.wav"
        FFmpegProcessor.extract_audio(
            video_path=video_path,
            output_path=audio_path,
        )
        assert audio_path.exists(), "Audio extraction failed"
        logger.info("✓ Audio extraction")

        # Test concatenation
        concat_path = tmpdir / "concat.mp4"
        FFmpegProcessor.concatenate_segments(
            segment_paths=[segment_path, segment_path],
            output_path=concat_path,
            reencode=True,
        )

        concat_info = get_video_info(concat_path)
        assert 5.5 < concat_info.duration < 6.5, f"Concat duration: {concat_info.duration}"
        logger.info(f"✓ Concatenation: {concat_info.duration:.2f}s")

    return True


def test_overlay_engine():
    """Test visual overlay creation and application."""
    logger.info("Testing overlay engine...")

    from src.visual import OverlayEngine
    from src.core import get_video_info

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create test video
        video_path = tmpdir / "original.mp4"
        create_test_video(video_path, duration=5.0)

        # Create overlay engine
        engine = OverlayEngine(temp_dir=tmpdir / "overlays")

        try:
            # Create text overlay
            text_overlay = engine.create_text_overlay(
                text="Hello Alice!",
                x=100,
                y=100,
                start_time=1.0,
                end_time=4.0,
                font_size=48,
                color=(255, 255, 255),
            )

            assert text_overlay.image_path.exists(), "Text overlay image not created"
            logger.info("✓ Text overlay created")

            # Apply overlays
            output_path = tmpdir / "with_overlay.mp4"
            engine.apply_overlays(
                video_path=video_path,
                overlays=[text_overlay],
                output_path=output_path,
            )

            assert output_path.exists(), "Overlay output not created"
            output_info = get_video_info(output_path)
            logger.info(f"✓ Overlays applied: {output_info.duration:.2f}s")

        finally:
            engine.cleanup()

    return True


def test_video_composer():
    """Test video composition."""
    logger.info("Testing video composer...")

    from src.compose import VideoComposer
    from src.compose.composer import ProcessedSegment
    from src.core import FFmpegProcessor, get_video_info

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create test video (10 seconds)
        video_path = tmpdir / "original.mp4"
        create_test_video(video_path, duration=10.0)

        # Extract a segment (simulate lip-synced segment)
        processed_segment = tmpdir / "processed.mp4"
        FFmpegProcessor.extract_segment(
            video_path=video_path,
            start_time=3.0,
            end_time=6.0,
            output_path=processed_segment,
            reencode=True,
        )

        # Compose
        composer = VideoComposer()

        try:
            output_path = tmpdir / "composed.mp4"

            composer.compose(
                original_video=video_path,
                processed_segments=[
                    ProcessedSegment(
                        video_path=processed_segment,
                        start_time=3.0,
                        end_time=6.0,
                    )
                ],
                output_path=output_path,
            )

            assert output_path.exists(), "Composed video not created"

            output_info = get_video_info(output_path)
            # Should be approximately same duration as original
            assert 9.5 < output_info.duration < 10.5, f"Duration: {output_info.duration}"

            logger.info(f"✓ Video composed: {output_info.duration:.2f}s")

        finally:
            composer.cleanup()

    return True


def test_voice_client():
    """Test ElevenLabs voice client (requires API key)."""
    api_key = os.getenv("ELEVENLABS_API_KEY")

    if not api_key:
        logger.warning("⚠ Skipping voice test: ELEVENLABS_API_KEY not set")
        return True

    logger.info("Testing voice client...")

    from src.voice import VoiceClient
    from src.core import get_audio_duration

    client = VoiceClient(api_key=api_key)

    # List voices
    voices = client.list_voices()
    logger.info(f"✓ Found {len(voices)} voices")

    if not voices:
        logger.warning("⚠ No voices available, skipping generation test")
        return True

    # Use first available voice
    voice_id = voices[0]["id"]

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Generate speech for segment (should match 3 second duration)
        output_path = tmpdir / "speech.wav"

        client.generate_for_segment(
            text="Hello Alice, welcome to the demo!",
            voice_id=voice_id,
            target_duration=3.0,
            output_path=output_path,
        )

        assert output_path.exists(), "Audio not generated"

        duration = get_audio_duration(output_path)
        logger.info(f"✓ Generated speech: {duration:.2f}s (target: 3.0s)")

        # Check duration is close to target
        assert 2.8 < duration < 3.2, f"Duration mismatch: {duration}"

    return True


def test_synclabs_client():
    """Test Sync Labs lip-sync client (requires API key)."""
    api_key = os.getenv("SYNCLABS_API_KEY")

    if not api_key:
        logger.warning("⚠ Skipping lip-sync test: SYNCLABS_API_KEY not set")
        return True

    logger.info("Testing Sync Labs client...")

    from src.lipsync import SyncLabsClient

    client = SyncLabsClient(api_key=api_key)

    # Just test that we can initialize (actual lip-sync costs money)
    logger.info("✓ Sync Labs client initialized")
    logger.info("  (Full lip-sync test skipped to avoid API costs)")

    return True


def test_full_pipeline_mock():
    """Test full pipeline flow without external APIs."""
    logger.info("Testing full pipeline (mock mode)...")

    from src.pipeline import (
        PersonalizationPipeline,
        TemplateConfig,
        VoiceSegmentConfig,
        VisualOverlayConfig,
        PersonalizationData,
    )
    from src.core import get_video_info

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Create test video
        video_path = tmpdir / "base_video.mp4"
        create_test_video(video_path, duration=10.0)

        # Create template with only visual overlays (no voice/lipsync)
        template = TemplateConfig(
            id="test-template",
            name="Test Template",
            voice_id="",  # No voice
            voice_segments=[],  # Skip voice segments
            visual_overlays=[
                VisualOverlayConfig(
                    id="name_overlay",
                    type="text",
                    x=0.1,  # 10% from left
                    y=0.1,  # 10% from top
                    start_time=1.0,
                    end_time=8.0,
                    text_template="{client_name}",
                    font_size=72,
                    color=(255, 255, 255),
                ),
                VisualOverlayConfig(
                    id="company_overlay",
                    type="text",
                    x=0.1,
                    y=0.2,
                    start_time=2.0,
                    end_time=8.0,
                    text_template="{company_name}",
                    font_size=48,
                    color=(200, 200, 200),
                ),
            ],
        )

        # Create personalization data
        data = PersonalizationData(
            client_name="Alice Smith",
            company_name="Acme Corporation",
        )

        # Run pipeline
        pipeline = PersonalizationPipeline()

        try:
            output_path = tmpdir / "personalized.mp4"

            result = pipeline.personalize(
                video_path=video_path,
                template=template,
                data=data,
                output_path=output_path,
            )

            assert result.exists(), "Pipeline output not created"

            output_info = get_video_info(result)
            logger.info(f"✓ Pipeline complete: {output_info.duration:.2f}s")

            # Verify duration preserved
            assert 9.5 < output_info.duration < 10.5, f"Duration changed: {output_info.duration}"

        finally:
            pipeline.cleanup()

    return True


def run_all_tests():
    """Run all tests."""
    logger.info("=" * 60)
    logger.info("Personalized Video Pipeline - Test Suite")
    logger.info("=" * 60)

    # Check prerequisites
    if not check_ffmpeg() or not check_ffprobe():
        logger.error("Missing prerequisites. Install FFmpeg first.")
        return False

    tests = [
        ("Imports", test_imports),
        ("Video Info", test_video_info),
        ("FFmpeg Operations", test_ffmpeg_operations),
        ("Overlay Engine", test_overlay_engine),
        ("Video Composer", test_video_composer),
        ("Voice Client", test_voice_client),
        ("Sync Labs Client", test_synclabs_client),
        ("Full Pipeline (Mock)", test_full_pipeline_mock),
    ]

    results = []

    for name, test_fn in tests:
        logger.info("-" * 40)
        logger.info(f"Running: {name}")

        try:
            passed = test_fn()
            results.append((name, passed, None))
        except Exception as e:
            logger.exception(f"Test failed: {name}")
            results.append((name, False, str(e)))

    # Summary
    logger.info("=" * 60)
    logger.info("Test Summary")
    logger.info("=" * 60)

    passed = 0
    failed = 0

    for name, success, error in results:
        if success:
            logger.info(f"✓ {name}")
            passed += 1
        else:
            logger.error(f"✗ {name}: {error or 'Failed'}")
            failed += 1

    logger.info("-" * 40)
    logger.info(f"Passed: {passed}/{len(results)}")

    if failed > 0:
        logger.error(f"Failed: {failed}")
        return False

    logger.info("All tests passed!")
    return True


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
