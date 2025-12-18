"""
Video information extraction using ffprobe.

This is the foundation - we need accurate duration and timing info
for everything else to work.
"""

import subprocess
import json
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


@dataclass
class VideoInfo:
    """Complete information about a video file."""
    duration: float          # Total duration in seconds
    width: int               # Frame width
    height: int              # Frame height
    fps: float               # Frames per second
    video_codec: str         # e.g., "h264"
    audio_codec: Optional[str]  # e.g., "aac", None if no audio
    audio_sample_rate: Optional[int]  # e.g., 44100
    bitrate: Optional[int]   # Overall bitrate in bits/sec
    path: Path


def get_video_info(video_path: str | Path) -> VideoInfo:
    """
    Extract complete video information using ffprobe.

    This is critical for accurate segment extraction and timing.
    """
    video_path = Path(video_path)

    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    # Run ffprobe with JSON output
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(video_path)
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        # Try to get more info about the file
        import os
        file_exists = video_path.exists()
        file_size = os.path.getsize(video_path) if file_exists else 0
        raise RuntimeError(f"ffprobe failed for {video_path} (exists={file_exists}, size={file_size}): {result.stderr}")

    data = json.loads(result.stdout)

    # Extract format info
    format_info = data.get("format", {})
    duration = float(format_info.get("duration", 0))
    bitrate = int(format_info.get("bit_rate", 0)) if format_info.get("bit_rate") else None

    # Find video and audio streams
    video_stream = None
    audio_stream = None

    for stream in data.get("streams", []):
        if stream["codec_type"] == "video" and video_stream is None:
            video_stream = stream
        elif stream["codec_type"] == "audio" and audio_stream is None:
            audio_stream = stream

    if video_stream is None:
        raise ValueError(f"No video stream found in {video_path}")

    # Parse video stream
    width = int(video_stream["width"])
    height = int(video_stream["height"])
    video_codec = video_stream["codec_name"]

    # Parse FPS (can be fractional like "30000/1001")
    fps_str = video_stream.get("r_frame_rate", "30/1")
    if "/" in fps_str:
        num, den = fps_str.split("/")
        fps = float(num) / float(den)
    else:
        fps = float(fps_str)

    # Parse audio stream if present
    audio_codec = None
    audio_sample_rate = None
    if audio_stream:
        audio_codec = audio_stream["codec_name"]
        audio_sample_rate = int(audio_stream.get("sample_rate", 44100))

    return VideoInfo(
        duration=duration,
        width=width,
        height=height,
        fps=fps,
        video_codec=video_codec,
        audio_codec=audio_codec,
        audio_sample_rate=audio_sample_rate,
        bitrate=bitrate,
        path=video_path,
    )


def fix_webm_duration(video_path: str | Path) -> Path:
    """
    Fix WebM files that have missing/incorrect duration metadata.

    MediaRecorder WebM files often have Infinity duration because
    the duration metadata is written at the end of the file but
    the initial header has no duration. Re-muxing with ffmpeg fixes this.

    Returns the path to the fixed file (may be the same if no fix needed).
    """
    video_path = Path(video_path)

    try:
        # Only process WebM files
        if video_path.suffix.lower() != '.webm':
            return video_path

        # Check if duration is valid
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            str(video_path)
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            return video_path

        data = json.loads(result.stdout)
        duration = float(data.get("format", {}).get("duration", 0))

        # If duration is valid, no fix needed
        if duration > 0:
            return video_path

        # Remux to fix duration - ffmpeg will compute it properly
        fixed_path = video_path.parent / f"{video_path.stem}_fixed.webm"

        fix_cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-c", "copy",  # No re-encoding, just remux
            str(fixed_path)
        ]

        result = subprocess.run(fix_cmd, capture_output=True, text=True)

        if result.returncode == 0 and fixed_path.exists():
            # Verify the fixed file is valid before replacing
            verify_cmd = [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_format", str(fixed_path)
            ]
            verify = subprocess.run(verify_cmd, capture_output=True, text=True)
            if verify.returncode == 0:
                # Replace original with fixed version
                import shutil
                import os
                os.remove(str(video_path))
                shutil.move(str(fixed_path), str(video_path))
                return video_path
            else:
                # Fixed file is invalid, remove it
                if fixed_path.exists():
                    os.remove(str(fixed_path))

        # Clean up failed fix attempt
        if fixed_path.exists():
            import os
            os.remove(str(fixed_path))

    except Exception as e:
        # If anything fails, just return original path
        print(f"fix_webm_duration failed: {e}")

    return video_path


def get_audio_duration(audio_path: str | Path) -> float:
    """Get duration of an audio file."""
    audio_path = Path(audio_path)

    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        str(audio_path)
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")

    data = json.loads(result.stdout)
    return float(data["format"]["duration"])
