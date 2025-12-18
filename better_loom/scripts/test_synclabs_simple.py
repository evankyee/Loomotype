#!/usr/bin/env python3
"""
Simple Sync Labs Test

Creates a test video with a face, sends it through Sync Labs,
and saves both input and output for visual comparison.

Usage:
    python scripts/test_synclabs_simple.py [path_to_test_video]

If no video provided, uses the most recent video from temp uploads.
"""

import os
import sys
import tempfile
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

from loguru import logger

logger.remove()
logger.add(sys.stderr, level="INFO", format="<green>{time:HH:mm:ss}</green> | <level>{message}</level>")


def create_test_audio(duration: float, output_path: Path):
    """Create a simple test audio file with speech synthesis."""
    # Use macOS say command to create test audio
    text = "Hello, this is a lip sync test. The lips should move with this audio."

    # Generate speech
    aiff_path = output_path.with_suffix(".aiff")
    subprocess.run([
        "say", "-o", str(aiff_path), text
    ], check=True)

    # Convert to WAV
    subprocess.run([
        "ffmpeg", "-y", "-i", str(aiff_path),
        "-acodec", "pcm_s16le", "-ar", "24000",
        "-t", str(duration),
        str(output_path)
    ], capture_output=True)

    aiff_path.unlink(missing_ok=True)
    return output_path


def extract_segment(video_path: Path, output_path: Path, duration: float = 3.0):
    """Extract a short segment from the video."""
    subprocess.run([
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-ar", "48000",
        str(output_path)
    ], capture_output=True)


def get_video_info(path: Path) -> dict:
    """Get video info."""
    import json
    result = subprocess.run([
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(path)
    ], capture_output=True, text=True)
    data = json.loads(result.stdout)
    video_stream = next((s for s in data.get("streams", []) if s["codec_type"] == "video"), {})
    return {
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
        "duration": float(data.get("format", {}).get("duration", 0)),
    }


def main():
    logger.info("=" * 60)
    logger.info("SYNC LABS SIMPLE TEST")
    logger.info("=" * 60)

    # Find test video
    if len(sys.argv) > 1:
        test_video = Path(sys.argv[1])
    else:
        # Look for recent uploads
        upload_dir = Path(tempfile.gettempdir()) / "soron" / "uploads"
        if upload_dir.exists():
            videos = list(upload_dir.rglob("*.mp4")) + list(upload_dir.rglob("*.webm"))
            if videos:
                test_video = sorted(videos, key=lambda x: x.stat().st_mtime, reverse=True)[0]
                logger.info(f"Using most recent upload: {test_video}")
            else:
                logger.error("No videos found in uploads. Please provide a video path.")
                return
        else:
            logger.error("No uploads directory. Please provide a video path.")
            return

    if not test_video.exists():
        logger.error(f"Video not found: {test_video}")
        return

    # Get video info
    info = get_video_info(test_video)
    logger.info(f"\nInput video: {test_video.name}")
    logger.info(f"  Dimensions: {info['width']}x{info['height']}")
    logger.info(f"  Duration: {info['duration']:.2f}s")

    # Check if video is too small
    min_dim = min(info['width'], info['height'])
    if min_dim < 256:
        logger.warning(f"\n⚠️  Video is very small ({min_dim}px). Face detection may fail!")
        logger.warning("   Sync Labs works best with faces >= 256px")

    # Create output directory
    output_dir = Path("test_output")
    output_dir.mkdir(exist_ok=True)

    # Extract a 3-second segment for testing
    segment_path = output_dir / "test_segment.mp4"
    logger.info(f"\nExtracting 3-second segment...")
    extract_segment(test_video, segment_path, duration=3.0)

    segment_info = get_video_info(segment_path)
    logger.info(f"  Segment: {segment_info['width']}x{segment_info['height']}, {segment_info['duration']:.2f}s")

    # Create test audio
    audio_path = output_dir / "test_audio.wav"
    logger.info(f"\nCreating test audio...")
    create_test_audio(segment_info['duration'], audio_path)
    logger.info(f"  Audio created: {audio_path}")

    # Run lip-sync
    logger.info(f"\nSending to Sync Labs...")
    logger.info("  This may take 30-60 seconds...")

    try:
        from src.lipsync.synclabs import SyncLabsClient

        client = SyncLabsClient()
        output_path = output_dir / "test_lipsync_output.mp4"

        result = client.lipsync(
            video_path=segment_path,
            audio_path=audio_path,
            output_path=output_path,
        )

        logger.info(f"\n✓ Lip-sync complete!")
        logger.info(f"  Output: {output_path}")

        output_info = get_video_info(output_path)
        logger.info(f"  Dimensions: {output_info['width']}x{output_info['height']}")
        logger.info(f"  Duration: {output_info['duration']:.2f}s")

        # Compare hashes
        import hashlib
        input_hash = hashlib.md5(segment_path.read_bytes()).hexdigest()[:12]
        output_hash = hashlib.md5(output_path.read_bytes()).hexdigest()[:12]

        logger.info(f"\nFile comparison:")
        logger.info(f"  Input MD5:  {input_hash}")
        logger.info(f"  Output MD5: {output_hash}")
        logger.info(f"  Files differ: {input_hash != output_hash}")

        logger.info(f"\n" + "=" * 60)
        logger.info("PLEASE VISUALLY COMPARE THESE FILES:")
        logger.info("=" * 60)
        logger.info(f"  Input:  {segment_path.absolute()}")
        logger.info(f"  Output: {output_path.absolute()}")
        logger.info("\nOpen both in a video player and check if lips are moving differently.")
        logger.info("If lips look THE SAME, Sync Labs is not detecting/processing the face.")
        logger.info("If lips look DIFFERENT, Sync Labs is working - issue is in composition.")

    except Exception as e:
        logger.error(f"\n✗ Lip-sync failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
