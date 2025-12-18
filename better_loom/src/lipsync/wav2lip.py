"""
Wav2Lip Local Implementation

Self-hosted lip-sync using Wav2Lip model.
Requires a GPU for reasonable performance.

Setup:
1. Clone Wav2Lip: git clone https://github.com/Rudrabha/Wav2Lip
2. Download models to models/wav2lip/
3. Install dependencies: pip install -r Wav2Lip/requirements.txt
"""

from pathlib import Path
from loguru import logger
import subprocess
import tempfile
import shutil
import os

from .engine import BaseLipSync


class Wav2LipLocal(BaseLipSync):
    """
    Local Wav2Lip implementation.

    Uses the Wav2Lip model for lip synchronization.
    For best quality, we use wav2lip_gan.pth + face enhancement.
    """

    def __init__(
        self,
        wav2lip_path: str = "./models/wav2lip",
        checkpoint: str = "wav2lip_gan.pth",
        enhance: bool = True,
    ):
        """
        Args:
            wav2lip_path: Path to Wav2Lip installation
            checkpoint: Model checkpoint to use
            enhance: Whether to apply face enhancement (GFPGAN)
        """
        self.wav2lip_path = Path(wav2lip_path)
        self.checkpoint = self.wav2lip_path / "checkpoints" / checkpoint
        self.enhance = enhance

        # Verify setup
        if not self.checkpoint.exists():
            logger.warning(
                f"Wav2Lip checkpoint not found at {self.checkpoint}. "
                "Download from: https://github.com/Rudrabha/Wav2Lip"
            )

    def sync(
        self,
        video_path: Path,
        audio_path: Path,
        output_path: Path,
        start_time: float = 0,
        end_time: float = None,
    ) -> Path:
        """
        Apply lip-sync using Wav2Lip.

        This calls the Wav2Lip inference script.
        """
        video_path = Path(video_path)
        audio_path = Path(audio_path)
        output_path = Path(output_path)

        logger.info(f"Running Wav2Lip: {video_path.name} + {audio_path.name}")

        # Create temp output directory
        temp_dir = Path(tempfile.mkdtemp())
        temp_output = temp_dir / "result.mp4"

        try:
            # Run Wav2Lip inference
            cmd = [
                "python",
                str(self.wav2lip_path / "inference.py"),
                "--checkpoint_path", str(self.checkpoint),
                "--face", str(video_path),
                "--audio", str(audio_path),
                "--outfile", str(temp_output),
                "--resize_factor", "1",
                "--nosmooth",  # Better quality without smoothing
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=str(self.wav2lip_path),
            )

            if result.returncode != 0:
                logger.error(f"Wav2Lip failed: {result.stderr}")
                raise RuntimeError(f"Wav2Lip failed: {result.stderr}")

            # Apply face enhancement if enabled
            if self.enhance and temp_output.exists():
                enhanced = self._enhance_face(temp_output)
                if enhanced:
                    temp_output = enhanced

            # Move to final output
            shutil.move(str(temp_output), str(output_path))

            logger.info(f"Lip-sync complete: {output_path}")
            return output_path

        finally:
            # Clean up temp directory
            shutil.rmtree(temp_dir, ignore_errors=True)

    def _enhance_face(self, video_path: Path) -> Path | None:
        """
        Apply GFPGAN face enhancement to improve quality.

        This helps restore fine details lost during lip-sync.
        """
        try:
            # Check if GFPGAN is available
            import gfpgan
        except ImportError:
            logger.warning("GFPGAN not installed, skipping enhancement")
            return None

        logger.info("Applying face enhancement with GFPGAN")

        # This is a simplified version - full implementation would
        # process frame by frame
        enhanced_path = video_path.with_suffix(".enhanced.mp4")

        # TODO: Implement frame-by-frame GFPGAN enhancement
        # For now, return original
        return None


class Wav2LipDocker(BaseLipSync):
    """
    Run Wav2Lip in a Docker container.

    Useful for Cloud Run deployments where you want
    isolation and reproducibility.
    """

    def __init__(self, image: str = "wav2lip:latest"):
        self.image = image

    def sync(
        self,
        video_path: Path,
        audio_path: Path,
        output_path: Path,
        start_time: float = 0,
        end_time: float = None,
    ) -> Path:
        """Run Wav2Lip via Docker."""
        video_path = Path(video_path)
        audio_path = Path(audio_path)
        output_path = Path(output_path)

        # Create temp directory for Docker mount
        work_dir = Path(tempfile.mkdtemp())
        shutil.copy(video_path, work_dir / "input.mp4")
        shutil.copy(audio_path, work_dir / "audio.mp3")

        try:
            cmd = [
                "docker", "run", "--rm", "--gpus", "all",
                "-v", f"{work_dir}:/data",
                self.image,
                "--face", "/data/input.mp4",
                "--audio", "/data/audio.mp3",
                "--outfile", "/data/output.mp4",
            ]

            result = subprocess.run(cmd, capture_output=True, text=True)

            if result.returncode != 0:
                raise RuntimeError(f"Docker Wav2Lip failed: {result.stderr}")

            # Move output
            shutil.move(str(work_dir / "output.mp4"), str(output_path))
            return output_path

        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
