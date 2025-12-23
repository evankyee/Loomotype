"""
FFmpeg utilities for video processing.

All video manipulation goes through here. No frame-by-frame processing.
Uses FFmpeg's native filters for speed and quality.
"""

import subprocess
import tempfile
import shutil
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
from loguru import logger

from .video_info import get_video_info, get_audio_duration


class FFmpegError(Exception):
    """FFmpeg operation failed."""
    pass


def run_ffmpeg(args: list[str], description: str = "FFmpeg operation") -> str:
    """
    Run an FFmpeg command with proper error handling.

    Returns stdout on success, raises FFmpegError on failure.
    """
    cmd = ["ffmpeg", "-y", "-hide_banner"] + args

    logger.debug(f"Running: {' '.join(cmd)}")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        logger.error(f"FFmpeg failed: {result.stderr}")
        raise FFmpegError(f"{description} failed: {result.stderr}")

    return result.stdout


# Cache hardware encoder availability check
_hw_encoder: Optional[str] = None  # "videotoolbox", "nvenc", or None


def detect_hardware_encoder() -> Optional[str]:
    """
    Detect best available hardware encoder.

    Returns:
        "videotoolbox" (macOS), "nvenc" (NVIDIA GPU), or None (CPU only)
    """
    global _hw_encoder
    if _hw_encoder is not None:
        return _hw_encoder if _hw_encoder != "none" else None

    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
        )
        encoders = result.stdout

        # Check in order of preference
        if "h264_videotoolbox" in encoders:
            _hw_encoder = "videotoolbox"
            logger.info("VideoToolbox hardware encoder available (macOS) - 5-10x faster")
        elif "h264_nvenc" in encoders:
            _hw_encoder = "nvenc"
            logger.info("NVENC hardware encoder available (NVIDIA GPU) - 5-10x faster")
        else:
            _hw_encoder = "none"
            logger.info("No hardware encoder available - using optimized CPU encoding")

        return _hw_encoder if _hw_encoder != "none" else None
    except Exception:
        _hw_encoder = "none"
        return None


def get_cpu_thread_count() -> int:
    """Get optimal thread count for FFmpeg (leave 1-2 cores for system)."""
    import os
    cores = os.cpu_count() or 4
    return max(1, cores - 1)  # Leave 1 core for system


def get_video_encoding_args(quality: str = "balanced") -> list[str]:
    """
    Get optimal video encoding arguments based on quality preset and hardware.

    Automatically uses:
    - VideoToolbox on macOS (5-10x faster)
    - NVENC on systems with NVIDIA GPU (5-10x faster)
    - Optimized multi-threaded libx264 on CPU (production servers)

    Args:
        quality: "fast" (quick preview), "balanced" (default), "ultra" (best quality)

    Returns:
        List of FFmpeg arguments for video encoding
    """
    hw_encoder = detect_hardware_encoder()
    threads = get_cpu_thread_count()

    if hw_encoder == "videotoolbox":
        # macOS VideoToolbox hardware encoding
        quality_map = {
            "fast": ["-c:v", "h264_videotoolbox", "-q:v", "65"],
            "balanced": ["-c:v", "h264_videotoolbox", "-q:v", "50"],
            "ultra": ["-c:v", "h264_videotoolbox", "-q:v", "35"],
        }
    elif hw_encoder == "nvenc":
        # NVIDIA NVENC hardware encoding
        # preset: p1 (fastest) to p7 (slowest/best quality)
        # cq: constant quality (0-51, lower = better)
        quality_map = {
            "fast": ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "28"],
            "balanced": ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"],
            "ultra": ["-c:v", "h264_nvenc", "-preset", "p7", "-cq", "18"],
        }
    else:
        # Optimized CPU encoding for production servers
        # Uses all available cores for maximum speed
        quality_map = {
            "fast": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", str(threads)],
            "balanced": ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", str(threads)],
            "ultra": ["-c:v", "libx264", "-preset", "slow", "-crf", "15", "-threads", str(threads)],
        }

    return quality_map.get(quality, quality_map["balanced"])


class FFmpegProcessor:
    """
    High-level FFmpeg operations for video personalization.

    All methods are stateless - input files in, output files out.
    """

    @staticmethod
    def extract_segment(
        video_path: Path,
        start_time: float,
        end_time: float,
        output_path: Path,
        reencode: bool = False,
    ) -> Path:
        """
        Extract a video segment.

        Args:
            video_path: Source video
            start_time: Start time in seconds
            end_time: End time in seconds
            output_path: Where to save the segment
            reencode: If True, re-encode for frame-accurate cuts

        Returns:
            Path to extracted segment
        """
        duration = end_time - start_time

        if duration <= 0:
            raise ValueError(f"Invalid segment: {start_time} to {end_time}")

        if reencode:
            # Frame-accurate but slower
            # Use hardware encoding if available (5-10x faster on macOS)
            video_enc_args = get_video_encoding_args("balanced")

            args = [
                "-ss", str(start_time),
                "-i", str(video_path),
                "-t", str(duration),
                *video_enc_args,
                "-r", "30",  # Force 30fps output (fixes WebM 1000fps metadata bug)
                "-g", "30",  # Keyframe every 30 frames (~1 sec at 30fps)
                "-keyint_min", "30",  # Minimum keyframe interval
                "-c:a", "aac",
                "-ar", "48000",  # Normalize audio sample rate
                "-b:a", "192k",
                str(output_path),
            ]
        else:
            # Fast copy (may not be frame-accurate)
            args = [
                "-ss", str(start_time),
                "-i", str(video_path),
                "-t", str(duration),
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                str(output_path),
            ]

        run_ffmpeg(args, f"Extract segment {start_time}-{end_time}")

        logger.info(f"Extracted segment: {start_time:.2f}s - {end_time:.2f}s")
        return output_path

    @staticmethod
    def extract_audio(
        video_path: Path,
        output_path: Path,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
    ) -> Path:
        """
        Extract audio from video.

        Optionally extract only a segment.
        """
        args = ["-i", str(video_path)]

        if start_time is not None:
            args = ["-ss", str(start_time)] + args

        if end_time is not None and start_time is not None:
            args += ["-t", str(end_time - start_time)]

        args += [
            "-vn",  # No video
            "-acodec", "pcm_s16le",  # WAV format for processing
            "-ar", "44100",  # Standard sample rate
            str(output_path),
        ]

        run_ffmpeg(args, "Extract audio")
        return output_path

    @staticmethod
    def add_silent_audio(
        video_path: Path,
        output_path: Path,
    ) -> Path:
        """
        Add silent audio track to a video-only file.

        This is needed for concatenating video-only segments with segments
        that have audio (like lip-synced segments from Sync Labs).
        FFmpeg concat requires all segments to have matching stream types.

        Args:
            video_path: Source video (video-only, no audio)
            output_path: Where to save the result (video + silent audio)

        Returns:
            Path to video with silent audio added
        """
        # Get video duration
        info = get_video_info(video_path)

        # Generate silent audio and mux with video
        # anullsrc generates silent audio, we trim it to match video duration
        args = [
            "-i", str(video_path),
            "-f", "lavfi",
            "-i", f"anullsrc=channel_layout=stereo:sample_rate=48000",
            "-t", str(info.duration),
            "-c:v", "copy",  # Don't re-encode video
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",  # End when video ends
            "-map", "0:v:0",  # Video from input 0
            "-map", "1:a:0",  # Audio from input 1 (silent)
            str(output_path),
        ]

        run_ffmpeg(args, "Add silent audio")
        logger.info(f"Added silent audio track to {video_path.name}")
        return output_path

    @staticmethod
    def has_audio_stream(video_path: Path) -> bool:
        """
        Check if a video file has an audio stream.

        Returns:
            True if the file has at least one audio stream
        """
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v", "error",
                    "-select_streams", "a",
                    "-show_entries", "stream=codec_type",
                    "-of", "csv=p=0",
                    str(video_path),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            # If there's any audio stream, ffprobe outputs "audio"
            return "audio" in result.stdout.lower()
        except Exception as e:
            logger.warning(f"Could not check audio streams: {e}")
            return False

    @staticmethod
    def time_stretch_audio(
        audio_path: Path,
        target_duration: float,
        output_path: Path,
    ) -> Path:
        """
        Time-stretch audio to exactly match target duration.

        Uses rubberband for high-quality pitch-preserving stretch.
        Falls back to atempo if rubberband unavailable.

        This is CRITICAL for keeping video in sync.
        """
        current_duration = get_audio_duration(audio_path)

        if abs(current_duration - target_duration) < 0.05:
            # Close enough, just copy
            shutil.copy(audio_path, output_path)
            return output_path

        # Calculate stretch ratio
        # rubberband tempo: < 1 = slower, > 1 = faster
        tempo_ratio = current_duration / target_duration

        logger.info(
            f"Time-stretching audio: {current_duration:.2f}s → {target_duration:.2f}s "
            f"(ratio: {tempo_ratio:.3f})"
        )

        # Try rubberband first (better quality)
        try:
            args = [
                "-i", str(audio_path),
                "-filter:a", f"rubberband=tempo={tempo_ratio}",
                "-t", str(target_duration),  # Ensure exact duration
                "-acodec", "pcm_s16le",
                "-ar", "44100",
                str(output_path),
            ]
            run_ffmpeg(args, "Time-stretch audio (rubberband)")

        except FFmpegError:
            # Fall back to atempo (lower quality but always available)
            logger.warning("rubberband unavailable, falling back to atempo")

            # atempo only supports 0.5-2.0 range, chain if needed
            filters = []
            remaining_ratio = tempo_ratio

            while remaining_ratio > 2.0:
                filters.append("atempo=2.0")
                remaining_ratio /= 2.0
            while remaining_ratio < 0.5:
                filters.append("atempo=0.5")
                remaining_ratio /= 0.5

            filters.append(f"atempo={remaining_ratio}")
            filter_str = ",".join(filters)

            args = [
                "-i", str(audio_path),
                "-filter:a", filter_str,
                "-t", str(target_duration),
                "-acodec", "pcm_s16le",
                "-ar", "44100",
                str(output_path),
            ]
            run_ffmpeg(args, "Time-stretch audio (atempo)")

        return output_path

    @staticmethod
    def replace_audio(
        video_path: Path,
        audio_path: Path,
        output_path: Path,
    ) -> Path:
        """
        Replace video's audio track with new audio.

        The audio should already be time-matched to the video.
        """
        args = [
            "-i", str(video_path),
            "-i", str(audio_path),
            "-c:v", "copy",  # Don't re-encode video
            "-map", "0:v:0",  # Video from first input
            "-map", "1:a:0",  # Audio from second input
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",  # End when shortest stream ends
            str(output_path),
        ]

        run_ffmpeg(args, "Replace audio")
        return output_path

    @staticmethod
    def normalize_audio_loudness(
        audio_path: Path,
        output_path: Path,
        target_lufs: float = -16.0,  # Standard for video content
    ) -> Path:
        """
        Normalize audio to a target loudness level (LUFS).

        This ensures the generated voice matches the original video's volume.
        -16 LUFS is standard for online video content.
        """
        args = [
            "-i", str(audio_path),
            "-filter:a", f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",
            "-acodec", "pcm_s16le",
            "-ar", "44100",  # Keep at ElevenLabs native rate (no resampling)
            str(output_path),
        ]

        run_ffmpeg(args, f"Normalize audio to {target_lufs} LUFS")
        logger.info(f"Audio normalized to {target_lufs} LUFS")
        return output_path

    @staticmethod
    def get_audio_loudness(audio_path: Path) -> float:
        """Get the integrated loudness of an audio file in LUFS."""
        import subprocess
        import json

        cmd = [
            "ffmpeg", "-i", str(audio_path),
            "-af", "loudnorm=print_format=json",
            "-f", "null", "-"
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)

        # Parse the loudnorm stats from stderr
        try:
            # Find the JSON output in stderr
            lines = result.stderr.split('\n')
            json_start = None
            for i, line in enumerate(lines):
                if '"input_i"' in line:
                    json_start = i - 1
                    break

            if json_start is not None:
                json_str = '\n'.join(lines[json_start:json_start+12])
                # Clean up to valid JSON
                json_str = json_str[json_str.find('{'):json_str.rfind('}')+1]
                data = json.loads(json_str)
                return float(data.get("input_i", -23))
        except Exception as e:
            logger.warning(f"Could not parse loudness: {e}")

        return -23.0  # Default fallback

    @staticmethod
    def concatenate_segments(
        segment_paths: list[Path],
        output_path: Path,
        reencode: bool = True,
        video_only: bool = False,
    ) -> Path:
        """
        Concatenate video segments in order.

        If segments have different codecs/parameters, set reencode=True.
        If segments are video-only (no audio), set video_only=True.
        """
        if not segment_paths:
            raise ValueError("No segments to concatenate")

        if len(segment_paths) == 1:
            shutil.copy(segment_paths[0], output_path)
            return output_path

        # Create concat file
        concat_file = output_path.parent / "concat_list.txt"
        with open(concat_file, "w") as f:
            for path in segment_paths:
                # Escape single quotes in path
                escaped = str(path).replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        try:
            if reencode:
                # Re-encode for compatibility (slower but safer)
                # Force keyframes every 1 second for smooth browser playback
                # Force 30fps output to prevent fps metadata corruption
                # Use faststart for progressive video loading (plays while downloading)
                args = [
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(concat_file),
                    *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
                    "-r", "30",  # Force 30fps output (fixes fps metadata issues)
                    "-g", "30",  # Keyframe every 30 frames (~1 sec at 30fps)
                    "-keyint_min", "30",  # Minimum keyframe interval
                ]

                if video_only:
                    args.append("-an")  # No audio output
                else:
                    # Normalize audio sample rate to 48000 Hz to handle Sync Labs output (44100 Hz)
                    args.extend([
                        "-c:a", "aac",
                        "-ar", "48000",
                        "-b:a", "192k",
                    ])

                args.extend([
                    "-movflags", "+faststart",  # Enable progressive playback
                    str(output_path),
                ])
            else:
                # Stream copy (fast but requires compatible segments)
                # Still use faststart for progressive playback
                args = [
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(concat_file),
                    "-c:v", "copy",
                ]

                if video_only:
                    args.append("-an")  # No audio output
                else:
                    args.extend(["-c:a", "copy"])

                args.extend([
                    "-movflags", "+faststart",
                    str(output_path),
                ])

            run_ffmpeg(args, "Concatenate segments")

        finally:
            concat_file.unlink(missing_ok=True)

        logger.info(f"Concatenated {len(segment_paths)} segments")
        return output_path

    @staticmethod
    def concatenate_with_crossfade(
        segment_paths: list[Path],
        output_path: Path,
        crossfade_duration: float = 0.075,
    ) -> Path:
        """
        Concatenate video segments with audio crossfade for seamless transitions.

        This is the preferred method for voice replacement segments where
        abrupt cuts between original and TTS audio can sound jarring.

        Args:
            segment_paths: List of video segment paths to concatenate
            output_path: Where to save the result
            crossfade_duration: Duration of audio crossfade in seconds (default 75ms)
                               50-100ms is perceptually seamless for speech

        Returns:
            Path to concatenated video with smooth audio transitions
        """
        if not segment_paths:
            raise ValueError("No segments to concatenate")

        if len(segment_paths) == 1:
            shutil.copy(segment_paths[0], output_path)
            return output_path

        # For 2 segments, use simple xfade filter
        if len(segment_paths) == 2:
            # Get duration of first segment to know where to start crossfade
            info1 = get_video_info(segment_paths[0])
            xfade_start = info1.duration - crossfade_duration

            args = [
                "-i", str(segment_paths[0]),
                "-i", str(segment_paths[1]),
                "-filter_complex",
                f"[0:v][1:v]xfade=transition=fade:duration={crossfade_duration}:offset={xfade_start}[v];"
                f"[0:a][1:a]acrossfade=d={crossfade_duration}:c1=tri:c2=tri[a]",
                "-map", "[v]",
                "-map", "[a]",
                *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
                "-c:a", "aac",
                "-ar", "48000",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(output_path),
            ]
            run_ffmpeg(args, "Concatenate with crossfade (2 segments)")
            return output_path

        # For multiple segments, build a complex filter chain
        # This chains xfades: [0+1] -> [temp1], [temp1+2] -> [temp2], etc.
        filter_complex = []
        current_offset = 0

        # Get durations for offset calculation
        durations = []
        for path in segment_paths:
            info = get_video_info(path)
            durations.append(info.duration)

        # Build input string
        inputs = []
        for path in segment_paths:
            inputs.extend(["-i", str(path)])

        # Build video xfade chain
        for i in range(len(segment_paths) - 1):
            if i == 0:
                prev_label = "0:v"
            else:
                prev_label = f"v{i-1}"

            next_label = f"{i+1}:v"

            if i == len(segment_paths) - 2:
                out_label = "vout"
            else:
                out_label = f"v{i}"

            # Calculate offset (cumulative duration minus crossfade overlap)
            current_offset = sum(durations[:i+1]) - (crossfade_duration * (i + 1))

            filter_complex.append(
                f"[{prev_label}][{next_label}]xfade=transition=fade:duration={crossfade_duration}:offset={current_offset}[{out_label}]"
            )

        # Build audio crossfade chain
        current_offset = 0
        for i in range(len(segment_paths) - 1):
            if i == 0:
                prev_label = "0:a"
            else:
                prev_label = f"a{i-1}"

            next_label = f"{i+1}:a"

            if i == len(segment_paths) - 2:
                out_label = "aout"
            else:
                out_label = f"a{i}"

            filter_complex.append(
                f"[{prev_label}][{next_label}]acrossfade=d={crossfade_duration}:c1=tri:c2=tri[{out_label}]"
            )

        args = inputs + [
            "-filter_complex", ";".join(filter_complex),
            "-map", "[vout]",
            "-map", "[aout]",
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-c:a", "aac",
            "-ar", "48000",
            "-b:a", "192k",
            "-movflags", "+faststart",
            str(output_path),
        ]

        run_ffmpeg(args, f"Concatenate with crossfade ({len(segment_paths)} segments)")
        logger.info(f"Concatenated {len(segment_paths)} segments with {crossfade_duration*1000:.0f}ms crossfade")
        return output_path

    @staticmethod
    def apply_overlay(
        video_path: Path,
        overlay_path: Path,
        output_path: Path,
        x: int,
        y: int,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
    ) -> Path:
        """
        Apply a single image overlay to video.

        Args:
            video_path: Source video
            overlay_path: PNG image to overlay (should have transparency)
            output_path: Where to save result
            x, y: Position (top-left corner of overlay)
            start_time, end_time: When overlay is visible (None = entire video)
        """
        # Build enable expression
        if start_time is not None and end_time is not None:
            enable = f"enable='between(t,{start_time},{end_time})'"
        elif start_time is not None:
            enable = f"enable='gte(t,{start_time})'"
        elif end_time is not None:
            enable = f"enable='lte(t,{end_time})'"
        else:
            enable = ""

        overlay_filter = f"overlay={x}:{y}"
        if enable:
            overlay_filter += f":{enable}"

        args = [
            "-i", str(video_path),
            "-i", str(overlay_path),
            "-filter_complex", f"[0][1]{overlay_filter}",
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-c:a", "copy",
            str(output_path),
        ]

        run_ffmpeg(args, "Apply overlay")
        return output_path

    @staticmethod
    def apply_multiple_overlays(
        video_path: Path,
        overlays: list[dict],
        output_path: Path,
    ) -> Path:
        """
        Apply multiple overlays in a single pass.

        Each overlay dict should have:
        - path: Path to PNG image
        - x, y: Position
        - start_time, end_time: Optional timing

        This is more efficient than applying overlays one at a time.
        """
        if not overlays:
            shutil.copy(video_path, output_path)
            return output_path

        # Build input list
        inputs = ["-i", str(video_path)]
        for overlay in overlays:
            inputs += ["-i", str(overlay["path"])]

        # Build filter complex
        filter_parts = []
        current_output = "0"

        for i, overlay in enumerate(overlays):
            input_idx = i + 1
            output_label = f"v{i}" if i < len(overlays) - 1 else ""

            # Build overlay filter
            x = overlay["x"]
            y = overlay["y"]
            overlay_filter = f"overlay={x}:{y}"

            # Add timing if specified
            start = overlay.get("start_time")
            end = overlay.get("end_time")
            if start is not None and end is not None:
                overlay_filter += f":enable='between(t,{start},{end})'"
            elif start is not None:
                overlay_filter += f":enable='gte(t,{start})'"
            elif end is not None:
                overlay_filter += f":enable='lte(t,{end})'"

            if output_label:
                filter_parts.append(f"[{current_output}][{input_idx}]{overlay_filter}[{output_label}]")
                current_output = output_label
            else:
                filter_parts.append(f"[{current_output}][{input_idx}]{overlay_filter}")

        filter_complex = ";".join(filter_parts)

        args = inputs + [
            "-filter_complex", filter_complex,
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-c:a", "copy",
            str(output_path),
        ]

        run_ffmpeg(args, "Apply multiple overlays")
        logger.info(f"Applied {len(overlays)} overlays")
        return output_path

    @staticmethod
    def scale_video(
        video_path: Path,
        output_path: Path,
        target_width: int,
        target_height: int,
        maintain_aspect: bool = True,
    ) -> Path:
        """
        Scale video to target dimensions.

        Args:
            video_path: Source video
            output_path: Where to save scaled video
            target_width: Target width in pixels
            target_height: Target height in pixels
            maintain_aspect: If True, scale to fit within target while maintaining aspect ratio

        Returns:
            Path to scaled video
        """
        if maintain_aspect:
            # Scale to fit within target dimensions while maintaining aspect ratio
            # Use -1 to auto-calculate one dimension
            scale_filter = f"scale='min({target_width},iw)':min'({target_height},ih)':force_original_aspect_ratio=decrease"
            # Pad to exact dimensions if needed
            pad_filter = f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:black"
            vf = f"{scale_filter},{pad_filter}"
        else:
            # Force exact dimensions (may distort)
            vf = f"scale={target_width}:{target_height}"

        args = [
            "-i", str(video_path),
            "-vf", vf,
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-c:a", "copy",
            str(output_path),
        ]

        run_ffmpeg(args, f"Scale video to {target_width}x{target_height}")
        logger.info(f"Scaled video to {target_width}x{target_height}")
        return output_path

    @staticmethod
    def upscale_for_lipsync(
        video_path: Path,
        output_path: Path,
        min_dimension: int = 512,
    ) -> tuple[Path, tuple[int, int]]:
        """
        Upscale video if needed for lip-sync processing.

        Sync Labs requires faces to be clearly visible. This function upscales
        small videos (like camera bubbles) to ensure face detection works.

        Args:
            video_path: Source video
            output_path: Where to save upscaled video
            min_dimension: Minimum dimension required (default 512px)

        Returns:
            Tuple of (output_path, original_dimensions)
        """
        info = get_video_info(video_path)
        original_dims = (info.width, info.height)

        current_min = min(info.width, info.height)

        if current_min >= min_dimension:
            # Already large enough, just copy
            shutil.copy(video_path, output_path)
            logger.info(f"Video already large enough ({info.width}x{info.height}), no upscaling needed")
            return output_path, original_dims

        # Calculate scale factor to reach minimum dimension
        scale_factor = min_dimension / current_min
        new_width = int(info.width * scale_factor)
        new_height = int(info.height * scale_factor)

        # Ensure even dimensions (required by many codecs)
        new_width = new_width + (new_width % 2)
        new_height = new_height + (new_height % 2)

        logger.info(f"Upscaling video from {info.width}x{info.height} to {new_width}x{new_height} for lip-sync")

        # Use high-quality lanczos scaling
        args = [
            "-i", str(video_path),
            "-vf", f"scale={new_width}:{new_height}:flags=lanczos",
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-c:a", "aac",
            "-ar", "48000",
            "-b:a", "192k",
            str(output_path),
        ]

        run_ffmpeg(args, f"Upscale video for lip-sync")
        return output_path, original_dims

    @staticmethod
    def downscale_to_original(
        video_path: Path,
        output_path: Path,
        original_dims: tuple[int, int],
    ) -> Path:
        """
        Downscale video back to original dimensions.

        Args:
            video_path: Upscaled video
            output_path: Where to save downscaled video
            original_dims: Original (width, height)

        Returns:
            Path to downscaled video
        """
        info = get_video_info(video_path)

        if info.width == original_dims[0] and info.height == original_dims[1]:
            # Already correct size, just copy
            shutil.copy(video_path, output_path)
            return output_path

        width, height = original_dims
        logger.info(f"Downscaling video from {info.width}x{info.height} back to {width}x{height}")

        # Use high-quality lanczos scaling
        args = [
            "-i", str(video_path),
            "-vf", f"scale={width}:{height}:flags=lanczos",
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-g", "30",  # Keyframe every 30 frames
            "-keyint_min", "30",
            "-c:a", "aac",
            "-ar", "48000",
            "-b:a", "192k",
            str(output_path),
        ]

        run_ffmpeg(args, f"Downscale video to {width}x{height}")
        return output_path

    @staticmethod
    def crop_bubble_region(
        video_path: Path,
        output_path: Path,
        bubble_size: int = 400,
        padding: int = 30,
        position: str = "bottom-left",
    ) -> Path:
        """
        Crop the camera bubble region from a screen recording.

        This extracts just the bubble area for lip-sync processing.
        The bubble should be circular, positioned at the specified location.

        Args:
            video_path: Screen recording with embedded bubble
            output_path: Where to save cropped bubble video
            bubble_size: Size of bubble in pixels
            padding: Padding from screen edge
            position: Bubble position ("bottom-left", "bottom-right", etc.)

        Returns:
            Path to cropped bubble video
        """
        info = get_video_info(video_path)
        screen_w = info.width
        screen_h = info.height

        # Calculate crop position based on bubble position
        if position == "bottom-left":
            x = padding
            y = screen_h - bubble_size - padding
        elif position == "bottom-right":
            x = screen_w - bubble_size - padding
            y = screen_h - bubble_size - padding
        elif position == "top-left":
            x = padding
            y = padding
        elif position == "top-right":
            x = screen_w - bubble_size - padding
            y = padding
        else:
            x = padding
            y = screen_h - bubble_size - padding

        logger.info(f"Cropping bubble region: {bubble_size}x{bubble_size} at ({x}, {y})")

        # Crop the bubble region and force 30fps
        args = [
            "-i", str(video_path),
            "-vf", f"crop={bubble_size}:{bubble_size}:{x}:{y}",
            *get_video_encoding_args("balanced"),  # Use hardware acceleration if available
            "-r", "30",
            "-c:a", "aac",
            "-ar", "48000",
            str(output_path),
        ]

        run_ffmpeg(args, f"Crop bubble region at {position}")
        logger.info(f"Bubble region cropped: {output_path}")
        return output_path

    @staticmethod
    def overlay_lipsync_bubble(
        original_video: Path,
        lipsync_bubble: Path,
        output_path: Path,
        bubble_size: int = 400,
        padding: int = 30,
        position: str = "bottom-left",
        new_audio: Optional[Path] = None,
    ) -> Path:
        """
        Overlay a lip-synced bubble back onto the original screen recording.

        This replaces the bubble region with the lip-synced version.

        Args:
            original_video: Original screen recording with embedded bubble
            lipsync_bubble: Lip-synced bubble video (cropped, same size as original bubble)
            output_path: Where to save result
            bubble_size: Size of bubble in pixels
            padding: Padding from screen edge
            position: Bubble position ("bottom-left", etc.)
            new_audio: Optional new audio to use (for ElevenLabs TTS)

        Returns:
            Path to video with lip-synced bubble
        """
        info = get_video_info(original_video)
        screen_w = info.width
        screen_h = info.height

        # Calculate overlay position
        if position == "bottom-left":
            x = padding
            y = screen_h - bubble_size - padding
        elif position == "bottom-right":
            x = screen_w - bubble_size - padding
            y = screen_h - bubble_size - padding
        elif position == "top-left":
            x = padding
            y = padding
        elif position == "top-right":
            x = screen_w - bubble_size - padding
            y = padding
        else:
            x = padding
            y = screen_h - bubble_size - padding

        logger.info(f"Overlaying lip-synced bubble at ({x}, {y})")

        # Simple rectangular overlay (bubble is already the right shape from crop)
        # Label the output as [vout] so we can map to it
        filter_complex = (
            f"[1:v]fps=30,scale={bubble_size}:{bubble_size}[bubble];"
            f"[0:v]fps=30[screen];"
            f"[screen][bubble]overlay={x}:{y}:shortest=1[vout]"
        )

        # Build FFmpeg args
        args = [
            "-i", str(original_video),
            "-i", str(lipsync_bubble),
        ]

        # Add audio input if provided (ElevenLabs TTS)
        if new_audio:
            args.extend(["-i", str(new_audio)])
            filter_complex += f";[2:a]aresample=48000[aud]"
            audio_map = "[aud]"
        else:
            audio_map = "1:a?"  # Use lip-synced bubble audio

        # Use hardware encoding if available (5-10x faster on macOS)
        video_enc_args = get_video_encoding_args("balanced")

        args.extend([
            "-filter_complex", filter_complex,
            "-map", "[vout]",  # Always use the composited overlay video
            *video_enc_args,
            "-r", "30",
            "-c:a", "aac",
            "-ar", "48000",
            "-map", audio_map,  # Map the audio (either new TTS or bubble audio)
        ])

        args.append(str(output_path))

        run_ffmpeg(args, "Overlay lip-synced bubble")
        logger.info(f"Lip-synced bubble overlaid at position {position}")
        return output_path

    @staticmethod
    def overlay_camera_bubble(
        screen_video: Path,
        camera_video: Path,
        output_path: Path,
        position: str = "bottom-right",
        bubble_size: int = 180,
        padding: int = 20,
        border_radius: int = 90,  # For circular bubble
        use_camera_audio: bool = False,  # Use camera audio (for lip-synced content)
        shape: str = "circle",  # circle, square, rounded
        custom_x: int = None,  # Custom x position (pixels)
        custom_y: int = None,  # Custom y position (pixels)
        visibility_filter: str = None,  # FFmpeg enable expression for time-based visibility
        quality: str = "balanced",  # fast, balanced, ultra
    ) -> Path:
        """
        Overlay camera video as a bubble onto screen recording.

        This composites the lip-synced camera video back onto the screen
        recording at the specified position.

        Args:
            screen_video: Main screen recording
            camera_video: Camera video (lip-synced) to overlay
            output_path: Where to save result
            position: "bottom-right", "bottom-left", "top-right", "top-left", "custom"
            bubble_size: Size of the bubble in pixels
            padding: Padding from screen edges
            border_radius: Radius for rounded corners (use bubble_size/2 for circle)
            use_camera_audio: If True, use audio from camera video (for lip-synced segments
                             with ElevenLabs audio). If False, use audio from screen.
            shape: Bubble shape - "circle", "square", or "rounded"
            custom_x: Custom x position in pixels (when position="custom")
            custom_y: Custom y position in pixels (when position="custom")
            visibility_filter: FFmpeg enable expression for time-based visibility
            quality: Encoding quality preset

        Returns:
            Path to composited video
        """
        screen_info = get_video_info(screen_video)
        screen_w = screen_info.width
        screen_h = screen_info.height

        # Calculate position based on screen size or use custom
        if position == "custom" and custom_x is not None and custom_y is not None:
            x = custom_x
            y = custom_y
        elif position == "bottom-right":
            x = screen_w - bubble_size - padding
            y = screen_h - bubble_size - padding
        elif position == "bottom-left":
            x = padding
            y = screen_h - bubble_size - padding
        elif position == "top-right":
            x = screen_w - bubble_size - padding
            y = padding
        elif position == "top-left":
            x = padding
            y = padding
        else:
            x = screen_w - bubble_size - padding
            y = screen_h - bubble_size - padding

        logger.info(f"Overlaying camera bubble at ({x}, {y}), size {bubble_size}x{bubble_size}, shape={shape}")
        logger.info(f"Audio source: {'camera (lip-synced)' if use_camera_audio else 'screen'}")
        logger.info(f"Screen: {screen_w}x{screen_h} @ {screen_info.fps}fps")

        # Get camera info for logging
        camera_info = get_video_info(camera_video)
        logger.info(f"Camera: {camera_info.width}x{camera_info.height} @ {camera_info.fps}fps")

        # Use screen's framerate as the target, but clamp to reasonable range
        # WebM files from MediaRecorder often report incorrect fps (like 1000fps)
        # Concatenated/processed files can also have weirdly low fps
        raw_fps = screen_info.fps or 30
        if raw_fps > 60:
            logger.warning(f"Screen fps {raw_fps} too high (WebM metadata issue), using 30fps")
            target_fps = 30
        elif raw_fps < 15:
            logger.warning(f"Screen fps {raw_fps} too low (corrupted metadata), using 30fps")
            target_fps = 30
        else:
            target_fps = raw_fps

        # Calculate radius for circle (half of bubble size)
        radius = bubble_size // 2

        # Build shape-specific filter
        if shape == "circle":
            # Circular mask using geq
            shape_filter = (
                f"format=rgba,"
                f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-{radius},2)+pow(Y-{radius},2),pow({radius},2)),255,0)'"
            )
        elif shape == "rounded":
            # Rounded rectangle with corner radius = 20% of size
            # Use drawbox approach: full square with rounded corners via alpha mask
            cr = bubble_size // 5  # corner radius
            sz = bubble_size
            # Alpha = 255 if pixel is inside rounded rect:
            # - In center (not in corner zones): always visible
            # - In corner zones: check distance from corner arc center
            shape_filter = (
                f"format=rgba,"
                f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                f"a='255*("
                # Center band (horizontal) - always visible
                f"between(X,{cr},{sz-cr})+"
                # Center band (vertical) - always visible
                f"between(Y,{cr},{sz-cr})+"
                # Top-left corner arc
                f"(lt(X,{cr})*lt(Y,{cr})*lte(pow(X-{cr},2)+pow(Y-{cr},2),pow({cr},2)))+"
                # Top-right corner arc
                f"(gt(X,{sz-cr-1})*lt(Y,{cr})*lte(pow(X-{sz-cr},2)+pow(Y-{cr},2),pow({cr},2)))+"
                # Bottom-left corner arc
                f"(lt(X,{cr})*gt(Y,{sz-cr-1})*lte(pow(X-{cr},2)+pow(Y-{sz-cr},2),pow({cr},2)))+"
                # Bottom-right corner arc
                f"(gt(X,{sz-cr-1})*gt(Y,{sz-cr-1})*lte(pow(X-{sz-cr},2)+pow(Y-{sz-cr},2),pow({cr},2)))"
                f")'"
            )
        else:  # square
            shape_filter = "format=rgba"  # No alpha masking needed for square

        # Build overlay with optional visibility filter
        overlay_params = f"{x}:{y}:format=auto:shortest=1"
        if visibility_filter:
            overlay_params += f":enable='{visibility_filter}'"
            logger.info(f"Time-based visibility: {visibility_filter}")

        # Simpler, more reliable filter approach:
        # 1. Normalize screen fps
        # 2. Scale and crop camera to square
        # 3. Apply shape mask
        # 4. Overlay onto screen
        filter_complex = (
            # Normalize screen to target fps (WebM files report wrong fps)
            f"[0:v]fps={target_fps}[screen];"
            # Normalize camera fps, scale to bubble size, crop to square, apply shape mask
            f"[1:v]fps={target_fps},scale={bubble_size}:{bubble_size}:force_original_aspect_ratio=increase,"
            f"crop={bubble_size}:{bubble_size},{shape_filter}[cam];"
            # Overlay camera onto normalized screen
            f"[screen][cam]overlay={overlay_params}"
        )

        # Choose audio source:
        # - For lip-synced content: use camera audio (1:a) which has ElevenLabs TTS
        # - For non-lip-synced: use screen audio (0:a) which has original recording
        audio_map = "1:a?" if use_camera_audio else "0:a?"

        # Use hardware encoding if available (5-10x faster on macOS)
        video_enc_args = get_video_encoding_args(quality)

        args = [
            "-i", str(screen_video),
            "-i", str(camera_video),
            "-filter_complex", filter_complex,
            *video_enc_args,
            "-r", str(target_fps),  # Output framerate matches screen
            "-c:a", "aac",
            "-ar", "48000",
            "-map", audio_map,
            "-vsync", "cfr",  # Constant framerate
            str(output_path),
        ]

        run_ffmpeg(args, "Overlay camera bubble")
        logger.info(f"Camera bubble overlaid at position {position}")
        return output_path

    # ============================================================
    # Premium Features: Enhancement Processing
    # ============================================================

    @staticmethod
    def apply_zoom_effects(
        video_path: Path,
        output_path: Path,
        clicks: list[dict],
        zoom_factor: float = 1.5,
        zoom_duration: float = 2.0,
        ease_duration: float = 0.3,
    ) -> Path:
        """
        Apply zoom effects at click locations.

        Args:
            video_path: Source video
            output_path: Where to save result
            clicks: List of click events [{t, x, y, button}] with normalized coords
            zoom_factor: How much to zoom in (1.5 = 150%)
            zoom_duration: How long to stay zoomed (seconds)
            ease_duration: Duration of ease in/out (seconds)

        Returns:
            Path to video with zoom effects
        """
        if not clicks:
            shutil.copy(video_path, output_path)
            return output_path

        info = get_video_info(video_path)
        width = info.width
        height = info.height
        fps = info.fps or 30

        # Build zoompan filter with proper zoom and pan expressions
        # zoompan: z=zoom level, x/y=top-left corner of visible area, d=duration per frame
        # on = output frame number, we need to map time to frames

        zoom_exprs = []
        x_exprs = []
        y_exprs = []

        for click in clicks:
            t = click['t']
            cx = click['x'] * width   # Click center x in pixels
            cy = click['y'] * height  # Click center y in pixels

            frame_start = int(t * fps)
            frame_end = frame_start + int(zoom_duration * fps)
            ease_frames = int(ease_duration * fps)

            # Zoom expression with easing
            # Phase 1: ease in (frames start to start+ease)
            # Phase 2: hold (frames start+ease to end-ease)
            # Phase 3: ease out (frames end-ease to end)
            zoom_exprs.append(
                f"if(between(on,{frame_start},{frame_end}),"
                f"if(lt(on,{frame_start + ease_frames}),"
                f"1+({zoom_factor}-1)*(on-{frame_start})/{ease_frames},"
                f"if(gt(on,{frame_end - ease_frames}),"
                f"{zoom_factor}-({zoom_factor}-1)*(on-{frame_end - ease_frames})/{ease_frames},"
                f"{zoom_factor})),0)"
            )

            # Pan expressions - center on click point
            # x = click_x - (visible_width / 2) = click_x - (iw / zoom / 2)
            # Clamp to valid range: 0 to iw - iw/zoom
            x_exprs.append(
                f"if(between(on,{frame_start},{frame_end}),"
                f"max(0,min({cx}-iw/zoom/2,iw-iw/zoom)),0)"
            )
            y_exprs.append(
                f"if(between(on,{frame_start},{frame_end}),"
                f"max(0,min({cy}-ih/zoom/2,ih-ih/zoom)),0)"
            )

        # Combine all expressions - take the active one (non-zero)
        if len(clicks) == 1:
            zoom_expr = zoom_exprs[0].replace(",0)", f",1)")  # Default zoom=1
            x_expr = x_exprs[0].replace(",0)", f",iw/2-iw/zoom/2)")  # Default center
            y_expr = y_exprs[0].replace(",0)", f",ih/2-ih/zoom/2)")
        else:
            # Chain multiple zoom regions
            zoom_expr = "+".join(zoom_exprs)
            zoom_expr = f"if(gt({zoom_expr},0),{zoom_expr},1)"  # Default to 1 if no zoom active

            x_expr = "+".join(x_exprs)
            x_expr = f"if(gt({'+'.join(zoom_exprs)},0),{x_expr},iw/2-iw/zoom/2)"

            y_expr = "+".join(y_exprs)
            y_expr = f"if(gt({'+'.join(zoom_exprs)},0),{y_expr},ih/2-ih/zoom/2)"

        # Build the zoompan filter
        zoom_filter = (
            f"zoompan="
            f"z='{zoom_expr}':"
            f"x='{x_expr}':"
            f"y='{y_expr}':"
            f"d=1:fps={fps}:s={width}x{height}"
        )

        # Use hardware encoding if available (5-10x faster on macOS)
        video_enc_args = get_video_encoding_args("balanced")

        args = [
            "-i", str(video_path),
            "-vf", zoom_filter,
            *video_enc_args,
            "-c:a", "copy",
            str(output_path),
        ]

        run_ffmpeg(args, f"Apply zoom effects for {len(clicks)} clicks")
        logger.info(f"Applied zoom effects at {len(clicks)} click locations")
        return output_path

    @staticmethod
    def apply_blur_regions(
        video_path: Path,
        output_path: Path,
        regions: list[dict],
        blur_strength: int = 20,
    ) -> Path:
        """
        Apply blur to specified regions of the video.

        Args:
            video_path: Source video
            output_path: Where to save result
            regions: List of blur regions [{id, x, y, w, h, start, end}]
                     Coordinates are normalized (0-1)
            blur_strength: How strong the blur should be (1-100)

        Returns:
            Path to video with blurred regions
        """
        if not regions:
            shutil.copy(video_path, output_path)
            return output_path

        info = get_video_info(video_path)
        width = info.width
        height = info.height

        # Build filter_complex for all blur regions
        # Strategy: for each region, crop the area, blur it, overlay back
        filter_parts = []

        for i, region in enumerate(regions):
            # Convert normalized coords to pixels
            rx = int(region['x'] * width)
            ry = int(region['y'] * height)
            rw = int(region['w'] * width)
            rh = int(region['h'] * height)
            start = region.get('start', 0)
            end = region.get('end', info.duration)

            # Enable expression for time-limited blur
            enable = f"enable='between(t,{start},{end})'"

            # Crop region, blur it, then overlay back at same position
            filter_parts.append(
                f"[0:v]crop={rw}:{rh}:{rx}:{ry},boxblur={blur_strength}[blur{i}];"
                f"[tmp{i-1 if i > 0 else '0:v'}][blur{i}]overlay={rx}:{ry}:{enable}[tmp{i}]"
            )

        # Build final filter_complex string
        if len(regions) == 1:
            # Single region - simpler filter
            r = regions[0]
            rx = int(r['x'] * width)
            ry = int(r['y'] * height)
            rw = int(r['w'] * width)
            rh = int(r['h'] * height)
            start = r.get('start', 0)
            end = r.get('end', info.duration)

            filter_complex = (
                f"[0:v]split[bg][fg];"
                f"[fg]crop={rw}:{rh}:{rx}:{ry},boxblur={blur_strength}[blurred];"
                f"[bg][blurred]overlay={rx}:{ry}:enable='between(t,{start},{end})'"
            )
        else:
            # Multiple regions - chain overlays
            parts = []
            for i, region in enumerate(regions):
                rx = int(region['x'] * width)
                ry = int(region['y'] * height)
                rw = int(region['w'] * width)
                rh = int(region['h'] * height)
                start = region.get('start', 0)
                end = region.get('end', info.duration)
                enable = f"enable='between(t,{start},{end})'"

                input_label = f"v{i-1}" if i > 0 else "0:v"
                output_label = f"v{i}" if i < len(regions) - 1 else ""

                parts.append(
                    f"[{input_label}]split[bg{i}][fg{i}];"
                    f"[fg{i}]crop={rw}:{rh}:{rx}:{ry},boxblur={blur_strength}[blur{i}];"
                    f"[bg{i}][blur{i}]overlay={rx}:{ry}:{enable}"
                    + (f"[{output_label}]" if output_label else "")
                )

            filter_complex = ";".join(parts)

        # Use hardware encoding if available (5-10x faster on macOS)
        video_enc_args = get_video_encoding_args("balanced")

        args = [
            "-i", str(video_path),
            "-filter_complex", filter_complex,
            *video_enc_args,
            "-c:a", "copy",
            str(output_path),
        ]

        run_ffmpeg(args, f"Apply blur to {len(regions)} regions")
        logger.info(f"Applied blur to {len(regions)} regions")
        return output_path

    @staticmethod
    def remove_segments(
        video_path: Path,
        output_path: Path,
        cuts: list[dict],
        crossfade_ms: int = 100,
    ) -> Path:
        """
        Remove segments from video (for filler word removal).

        Args:
            video_path: Source video
            output_path: Where to save result
            cuts: List of segments to REMOVE [{start, end}] in seconds
            crossfade_ms: Audio crossfade duration at cut points

        Returns:
            Path to video with segments removed
        """
        if not cuts:
            shutil.copy(video_path, output_path)
            return output_path

        info = get_video_info(video_path)
        duration = info.duration

        # Sort cuts by start time
        cuts = sorted(cuts, key=lambda x: x['start'])

        # Calculate segments to KEEP (inverse of cuts)
        keep_segments = []
        current_time = 0.0

        for cut in cuts:
            cut_start = cut['start']
            cut_end = cut['end']

            # Keep segment before this cut
            if cut_start > current_time:
                keep_segments.append({
                    'start': current_time,
                    'end': cut_start
                })

            current_time = cut_end

        # Keep segment after last cut
        if current_time < duration:
            keep_segments.append({
                'start': current_time,
                'end': duration
            })

        if not keep_segments:
            raise ValueError("No segments left after cuts")

        logger.info(f"Keeping {len(keep_segments)} segments after removing {len(cuts)} cuts")

        # Extract each segment to temp file
        temp_dir = Path(tempfile.mkdtemp())
        segment_paths = []

        try:
            for i, seg in enumerate(keep_segments):
                seg_path = temp_dir / f"segment_{i:04d}.mp4"
                FFmpegProcessor.extract_segment(
                    video_path,
                    seg['start'],
                    seg['end'],
                    seg_path,
                    reencode=True  # Re-encode for clean cuts
                )
                segment_paths.append(seg_path)

            # Concatenate all segments
            FFmpegProcessor.concatenate_segments(
                segment_paths,
                output_path,
                reencode=True
            )

            logger.info(f"Removed {len(cuts)} segments, output: {output_path}")
            return output_path

        finally:
            # Cleanup temp files
            shutil.rmtree(temp_dir, ignore_errors=True)
