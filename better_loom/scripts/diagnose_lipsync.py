#!/usr/bin/env python3
"""
Lip-Sync Diagnostic Script

This script helps diagnose why lip-sync might not be appearing in the final video.
It checks:
1. Whether Sync Labs is actually modifying the video
2. Whether the composition is using the correct files
3. Frame-by-frame comparison at key timestamps
"""

import os
import sys
import hashlib
import subprocess
import tempfile
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

from loguru import logger

# Configure logging
logger.remove()
logger.add(sys.stderr, level="INFO", format="<green>{time:HH:mm:ss}</green> | <level>{message}</level>")


def get_file_hash(path: Path) -> str:
    """Get MD5 hash of file."""
    return hashlib.md5(path.read_bytes()).hexdigest()


def get_video_info(path: Path) -> dict:
    """Get video dimensions and duration."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(path)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    import json
    data = json.loads(result.stdout)

    video_stream = next((s for s in data.get("streams", []) if s["codec_type"] == "video"), {})
    return {
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
        "duration": float(data.get("format", {}).get("duration", 0)),
        "size": int(data.get("format", {}).get("size", 0)),
    }


def extract_frame(video_path: Path, timestamp: float, output_path: Path):
    """Extract a single frame at given timestamp."""
    subprocess.run([
        "ffmpeg", "-y", "-ss", str(timestamp),
        "-i", str(video_path),
        "-frames:v", "1",
        "-q:v", "2",
        str(output_path)
    ], capture_output=True)


def compare_frames(frame1: Path, frame2: Path) -> dict:
    """Compare two frames and return similarity metrics."""
    hash1 = get_file_hash(frame1)
    hash2 = get_file_hash(frame2)

    # Also compare file sizes
    size1 = frame1.stat().st_size
    size2 = frame2.stat().st_size

    return {
        "hash1": hash1[:12],
        "hash2": hash2[:12],
        "hashes_match": hash1 == hash2,
        "size1": size1,
        "size2": size2,
        "size_diff_pct": abs(size1 - size2) / max(size1, size2) * 100
    }


def test_synclabs_basic():
    """Test if Sync Labs API is working at all with a simple request."""
    logger.info("=" * 60)
    logger.info("TEST 1: Sync Labs API Connection")
    logger.info("=" * 60)

    try:
        from src.lipsync.synclabs import SyncLabsClient
        client = SyncLabsClient()
        logger.info("✓ Sync Labs client initialized successfully")
        logger.info(f"  API Key: {client.api_key[:8]}...")
        return True
    except Exception as e:
        logger.error(f"✗ Failed to initialize Sync Labs: {e}")
        return False


def find_temp_files():
    """Find recent lip-sync related temp files."""
    logger.info("=" * 60)
    logger.info("TEST 2: Finding Recent Processing Files")
    logger.info("=" * 60)

    temp_dir = Path(tempfile.gettempdir()) / "soron" / "outputs"

    if not temp_dir.exists():
        logger.warning(f"Temp directory not found: {temp_dir}")
        return {}

    files = {
        "video_segments": list(temp_dir.glob("video_segment_*.mp4")),
        "upscaled": list(temp_dir.glob("upscaled_*.mp4")),
        "lipsync_raw": [f for f in temp_dir.glob("lipsync_*.mp4") if "normalized" not in f.name and "downscaled" not in f.name],
        "lipsync_normalized": list(temp_dir.glob("lipsync_*_normalized.mp4")),
        "lipsync_downscaled": list(temp_dir.glob("lipsync_*_downscaled.mp4")),
        "composed": list(temp_dir.glob("composed_*.mp4")),
        "voice": list(temp_dir.glob("voice_*.wav")),
    }

    for category, file_list in files.items():
        if file_list:
            logger.info(f"\n{category}:")
            for f in sorted(file_list, key=lambda x: x.stat().st_mtime, reverse=True)[:3]:
                info = get_video_info(f) if f.suffix == ".mp4" else {"size": f.stat().st_size}
                if "width" in info:
                    logger.info(f"  {f.name}: {info['width']}x{info['height']}, {info['duration']:.2f}s, {info['size']/1024:.1f}KB")
                else:
                    logger.info(f"  {f.name}: {info['size']/1024:.1f}KB")

    return files


def analyze_lipsync_pair(input_video: Path, output_video: Path):
    """Analyze a lip-sync input/output pair to check if lips were actually modified."""
    logger.info("=" * 60)
    logger.info("TEST 3: Analyzing Lip-Sync Input vs Output")
    logger.info("=" * 60)

    if not input_video.exists():
        logger.error(f"Input video not found: {input_video}")
        return
    if not output_video.exists():
        logger.error(f"Output video not found: {output_video}")
        return

    input_info = get_video_info(input_video)
    output_info = get_video_info(output_video)

    logger.info(f"\nInput:  {input_video.name}")
    logger.info(f"  Dimensions: {input_info['width']}x{input_info['height']}")
    logger.info(f"  Duration: {input_info['duration']:.2f}s")
    logger.info(f"  Size: {input_info['size']/1024:.1f}KB")
    logger.info(f"  MD5: {get_file_hash(input_video)[:12]}")

    logger.info(f"\nOutput: {output_video.name}")
    logger.info(f"  Dimensions: {output_info['width']}x{output_info['height']}")
    logger.info(f"  Duration: {output_info['duration']:.2f}s")
    logger.info(f"  Size: {output_info['size']/1024:.1f}KB")
    logger.info(f"  MD5: {get_file_hash(output_video)[:12]}")

    # Extract frames at multiple points and compare
    logger.info(f"\nFrame-by-frame comparison:")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Compare frames at 0.5s, 1.0s, 1.5s
        for t in [0.5, 1.0, 1.5]:
            if t > min(input_info['duration'], output_info['duration']):
                continue

            input_frame = tmpdir / f"input_{t}.jpg"
            output_frame = tmpdir / f"output_{t}.jpg"

            extract_frame(input_video, t, input_frame)
            extract_frame(output_video, t, output_frame)

            if input_frame.exists() and output_frame.exists():
                comparison = compare_frames(input_frame, output_frame)
                status = "SAME" if comparison["hashes_match"] else "DIFFERENT"
                logger.info(f"  t={t}s: {status} (input={comparison['hash1']}, output={comparison['hash2']})")
            else:
                logger.warning(f"  t={t}s: Could not extract frames")


def check_composition_logic():
    """Check if there are any obvious issues with the composition code."""
    logger.info("=" * 60)
    logger.info("TEST 4: Composition Code Check")
    logger.info("=" * 60)

    composer_path = Path(__file__).parent.parent / "src" / "compose" / "composer.py"

    if not composer_path.exists():
        logger.warning("Composer file not found")
        return

    content = composer_path.read_text()

    # Check for common issues
    issues = []

    if "segments_to_concat.append(seg.video_path)" not in content:
        issues.append("Processed segment might not be added to concatenation list")

    if "original_end_time" not in content:
        issues.append("May not be handling duration differences correctly")

    if issues:
        logger.warning("Potential issues found:")
        for issue in issues:
            logger.warning(f"  - {issue}")
    else:
        logger.info("✓ Composition logic looks correct")

    # Check for the [COMPOSE] logging we added
    if "[COMPOSE]" in content:
        logger.info("✓ Diagnostic logging is present in composer")
    else:
        logger.warning("Diagnostic logging not found in composer")


def main():
    logger.info("\n" + "=" * 60)
    logger.info("LIP-SYNC DIAGNOSTIC TOOL")
    logger.info("=" * 60 + "\n")

    # Test 1: API Connection
    if not test_synclabs_basic():
        logger.error("Cannot proceed without Sync Labs connection")
        return

    # Test 2: Find temp files
    files = find_temp_files()

    # Test 3: Analyze lip-sync pair if we have them
    if files.get("video_segments") and files.get("lipsync_raw"):
        # Get most recent pair
        input_video = sorted(files["video_segments"], key=lambda x: x.stat().st_mtime, reverse=True)[0]
        output_video = sorted(files["lipsync_raw"], key=lambda x: x.stat().st_mtime, reverse=True)[0]
        analyze_lipsync_pair(input_video, output_video)
    else:
        logger.warning("\nNo recent lip-sync files found to analyze.")
        logger.info("Run a personalization job first, then re-run this script.")

    # Test 4: Check composition logic
    check_composition_logic()

    logger.info("\n" + "=" * 60)
    logger.info("DIAGNOSIS COMPLETE")
    logger.info("=" * 60)
    logger.info("\nNext steps:")
    logger.info("1. Run a personalization job with a video")
    logger.info("2. Check the logs for [LIP-SYNC DEBUG] and [COMPOSE DEBUG] entries")
    logger.info("3. Re-run this script to analyze the intermediate files")
    logger.info("4. Visually inspect the lipsync_*.mp4 files in /tmp/soron/outputs/")


if __name__ == "__main__":
    main()
