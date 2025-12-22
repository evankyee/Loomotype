"""
Pitch Matching for Natural TTS Integration.

Extracts pitch (F0) contour from original audio and applies it to TTS output
to create seamless word replacements that match the speaker's natural intonation.

Uses Praat algorithms via parselmouth for accurate pitch extraction and PSOLA
for high-quality pitch manipulation that preserves voice quality.
"""

import tempfile
from pathlib import Path
from typing import Optional
import numpy as np
from loguru import logger

try:
    import parselmouth
    from parselmouth.praat import call
    PARSELMOUTH_AVAILABLE = True
except ImportError:
    PARSELMOUTH_AVAILABLE = False
    logger.warning("parselmouth not installed - pitch matching disabled")

try:
    import librosa
    import soundfile as sf
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False
    logger.warning("librosa/soundfile not installed - fallback pitch matching disabled")


class PitchMatcher:
    """
    Matches TTS output pitch to original audio for seamless word replacement.

    The key insight: ElevenLabs TTS generates speech with its own prosody,
    but for word replacement we need the NEW words to match the ORIGINAL
    speaker's pitch contour at that moment in time.

    Algorithm:
    1. Extract F0 (pitch) contour from original audio segment
    2. Extract F0 from TTS output
    3. Calculate frame-by-frame pitch ratio
    4. Apply pitch shifting using PSOLA (preserves voice quality)
    """

    def __init__(
        self,
        pitch_floor: float = 75.0,
        pitch_ceiling: float = 600.0,
        max_pitch_shift_semitones: float = 6.0,
    ):
        """
        Initialize the pitch matcher.

        Args:
            pitch_floor: Minimum F0 to detect (Hz). 75 for male, 100 for female.
            pitch_ceiling: Maximum F0 to detect (Hz). 300 for male, 500 for female.
            max_pitch_shift_semitones: Maximum allowed pitch shift (safety limit).
        """
        self.pitch_floor = pitch_floor
        self.pitch_ceiling = pitch_ceiling
        self.max_shift = max_pitch_shift_semitones

        if not PARSELMOUTH_AVAILABLE:
            logger.warning("PitchMatcher initialized without parselmouth - will pass through audio unchanged")

    def extract_pitch_contour(
        self,
        audio_path: Path,
        time_step: float = 0.01,
    ) -> tuple[np.ndarray, np.ndarray, float]:
        """
        Extract F0 contour from audio file using Praat's autocorrelation method.

        Args:
            audio_path: Path to audio file
            time_step: Time step between pitch samples (seconds)

        Returns:
            Tuple of (times, f0_values, sample_rate)
            - times: Array of time points
            - f0_values: F0 at each time (0 for unvoiced)
            - sample_rate: Audio sample rate
        """
        if not PARSELMOUTH_AVAILABLE:
            raise RuntimeError("parselmouth not available")

        # Load audio as Praat Sound object
        sound = parselmouth.Sound(str(audio_path))
        sample_rate = sound.sampling_frequency

        # Extract pitch using Praat's autocorrelation method
        # This is the gold standard for speech pitch extraction
        pitch = call(sound, "To Pitch (ac)",
                    time_step,           # Time step
                    self.pitch_floor,    # Pitch floor
                    15,                  # Max candidates
                    "no",                # Very accurate (slower)
                    0.03,                # Silence threshold
                    0.45,                # Voicing threshold
                    0.01,                # Octave cost
                    0.35,                # Octave-jump cost
                    0.14,                # Voiced/unvoiced cost
                    self.pitch_ceiling)  # Pitch ceiling

        # Extract values
        n_frames = call(pitch, "Get number of frames")
        times = np.array([call(pitch, "Get time from frame number", i+1) for i in range(n_frames)])
        f0_values = np.array([call(pitch, "Get value in frame", i+1, "Hertz") for i in range(n_frames)])

        # Replace undefined (unvoiced) with 0
        f0_values = np.nan_to_num(f0_values, nan=0.0)

        logger.debug(f"Extracted pitch: {len(times)} frames, voiced={np.sum(f0_values > 0)}, "
                    f"mean F0={np.mean(f0_values[f0_values > 0]):.1f}Hz")

        return times, f0_values, sample_rate

    def calculate_pitch_shift(
        self,
        original_f0: np.ndarray,
        tts_f0: np.ndarray,
    ) -> float:
        """
        Calculate the pitch shift needed to match TTS to original.

        Uses median of voiced frames for robust estimation.

        Args:
            original_f0: F0 contour of original audio
            tts_f0: F0 contour of TTS audio

        Returns:
            Pitch shift in semitones (positive = shift up)
        """
        # Get voiced frames only
        orig_voiced = original_f0[original_f0 > 0]
        tts_voiced = tts_f0[tts_f0 > 0]

        if len(orig_voiced) == 0 or len(tts_voiced) == 0:
            logger.warning("No voiced frames found - cannot calculate pitch shift")
            return 0.0

        # Use median for robust estimation (less sensitive to outliers)
        orig_median = np.median(orig_voiced)
        tts_median = np.median(tts_voiced)

        # Calculate shift in semitones: 12 * log2(f1/f2)
        if tts_median <= 0:
            return 0.0

        ratio = orig_median / tts_median
        shift_semitones = 12 * np.log2(ratio)

        # Clamp to safety limits
        if abs(shift_semitones) > self.max_shift:
            logger.warning(f"Pitch shift {shift_semitones:.1f} semitones exceeds limit, "
                          f"clamping to {self.max_shift}")
            shift_semitones = np.clip(shift_semitones, -self.max_shift, self.max_shift)

        logger.debug(f"Pitch shift: orig={orig_median:.1f}Hz, tts={tts_median:.1f}Hz, "
                    f"shift={shift_semitones:.2f} semitones")

        return float(shift_semitones)

    def apply_pitch_shift(
        self,
        audio_path: Path,
        shift_semitones: float,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Apply pitch shift to audio using PSOLA algorithm.

        PSOLA (Pitch Synchronous Overlap and Add) preserves voice quality
        while shifting pitch, unlike simple resampling which also changes speed.

        Args:
            audio_path: Input audio file
            shift_semitones: Amount to shift (positive = higher)
            output_path: Output file (optional, creates temp if not provided)

        Returns:
            Path to pitch-shifted audio
        """
        if not PARSELMOUTH_AVAILABLE:
            logger.warning("parselmouth not available - returning original audio")
            return audio_path

        if abs(shift_semitones) < 0.1:
            logger.debug("Pitch shift < 0.1 semitones - skipping")
            return audio_path

        # Load audio
        sound = parselmouth.Sound(str(audio_path))

        # Create manipulation object for PSOLA
        manipulation = call(sound, "To Manipulation", 0.01, self.pitch_floor, self.pitch_ceiling)

        # Get the pitch tier
        pitch_tier = call(manipulation, "Extract pitch tier")

        # Shift all pitch points by the specified amount
        # Formula: new_pitch = old_pitch * 2^(semitones/12)
        ratio = 2 ** (shift_semitones / 12)
        call(pitch_tier, "Multiply frequencies",
             sound.xmin, sound.xmax, ratio)

        # Replace the pitch tier in manipulation
        call([manipulation, pitch_tier], "Replace pitch tier")

        # Resynthesize with PSOLA
        shifted_sound = call(manipulation, "Get resynthesis (overlap-add)")

        # Save output
        if output_path is None:
            fd, output_path = tempfile.mkstemp(suffix=".wav")
            import os
            os.close(fd)
            output_path = Path(output_path)

        shifted_sound.save(str(output_path), "WAV")

        logger.debug(f"Applied pitch shift: {shift_semitones:.2f} semitones -> {output_path}")

        return output_path

    def match_pitch(
        self,
        original_audio: Path,
        tts_audio: Path,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Match TTS audio pitch to original audio.

        This is the main method for seamless word replacement.

        Args:
            original_audio: Original speaker audio segment
            tts_audio: TTS-generated replacement audio
            output_path: Where to save matched audio

        Returns:
            Path to pitch-matched TTS audio
        """
        if not PARSELMOUTH_AVAILABLE:
            logger.warning("parselmouth not available - returning original TTS audio")
            return tts_audio

        try:
            # Extract pitch from both
            _, orig_f0, _ = self.extract_pitch_contour(original_audio)
            _, tts_f0, _ = self.extract_pitch_contour(tts_audio)

            # Calculate required shift
            shift = self.calculate_pitch_shift(orig_f0, tts_f0)

            # Apply shift
            return self.apply_pitch_shift(tts_audio, shift, output_path)

        except Exception as e:
            logger.error(f"Pitch matching failed: {e}")
            return tts_audio

    def match_pitch_contour(
        self,
        original_audio: Path,
        tts_audio: Path,
        output_path: Optional[Path] = None,
    ) -> Path:
        """
        Advanced: Match the full pitch CONTOUR, not just median.

        This preserves the original intonation pattern (rising/falling)
        for more natural-sounding replacements.

        Args:
            original_audio: Original speaker audio segment
            tts_audio: TTS-generated replacement audio
            output_path: Where to save matched audio

        Returns:
            Path to contour-matched TTS audio
        """
        if not PARSELMOUTH_AVAILABLE:
            return tts_audio

        try:
            # Load both audio files
            orig_sound = parselmouth.Sound(str(original_audio))
            tts_sound = parselmouth.Sound(str(tts_audio))

            # Extract pitch from original
            orig_pitch = call(orig_sound, "To Pitch (ac)",
                            0.01, self.pitch_floor, 15, "no",
                            0.03, 0.45, 0.01, 0.35, 0.14, self.pitch_ceiling)

            # Create manipulation object for TTS
            manipulation = call(tts_sound, "To Manipulation",
                              0.01, self.pitch_floor, self.pitch_ceiling)

            # Create a new pitch tier from original pitch
            # This copies the exact contour shape
            orig_tier = call(orig_pitch, "Down to PitchTier")

            # Time-stretch the contour to match TTS duration
            orig_duration = orig_sound.duration
            tts_duration = tts_sound.duration

            if abs(orig_duration - tts_duration) > 0.01:
                # Scale time axis of pitch tier to match TTS duration
                # We need to create a new tier with scaled times
                duration_ratio = tts_duration / orig_duration

                # Get all points first (before modifying)
                n_points = call(orig_tier, "Get number of points")
                points = []
                for i in range(n_points):
                    t = call(orig_tier, "Get time from index", i + 1)
                    f = call(orig_tier, "Get value at index", i + 1)
                    points.append((t * duration_ratio, f))

                # Remove all points (in reverse order to preserve indices)
                for i in range(n_points, 0, -1):
                    call(orig_tier, "Remove point", i)

                # Add scaled points
                for t, f in points:
                    call(orig_tier, "Add point", t, f)

            # Replace TTS pitch with original contour
            call([manipulation, orig_tier], "Replace pitch tier")

            # Resynthesize
            matched_sound = call(manipulation, "Get resynthesis (overlap-add)")

            # Save
            if output_path is None:
                fd, output_path = tempfile.mkstemp(suffix=".wav")
                import os
                os.close(fd)
                output_path = Path(output_path)

            matched_sound.save(str(output_path), "WAV")

            logger.info(f"Matched pitch contour: {original_audio.name} -> {output_path.name}")
            return output_path

        except Exception as e:
            logger.error(f"Contour matching failed: {e}, falling back to median match")
            return self.match_pitch(original_audio, tts_audio, output_path)


# Module-level convenience functions
_matcher: Optional[PitchMatcher] = None


def get_pitch_matcher() -> PitchMatcher:
    """Get or create the pitch matcher singleton."""
    global _matcher
    if _matcher is None:
        _matcher = PitchMatcher()
    return _matcher


def match_tts_to_original(
    original_audio: Path,
    tts_audio: Path,
    output_path: Optional[Path] = None,
    use_contour: bool = True,
) -> Path:
    """
    Match TTS audio pitch to original speaker.

    Args:
        original_audio: Original segment from speaker
        tts_audio: Generated TTS audio
        output_path: Where to save result
        use_contour: If True, match full contour; if False, just median pitch

    Returns:
        Path to pitch-matched audio
    """
    matcher = get_pitch_matcher()

    if use_contour:
        return matcher.match_pitch_contour(original_audio, tts_audio, output_path)
    else:
        return matcher.match_pitch(original_audio, tts_audio, output_path)


def is_pitch_matching_available() -> bool:
    """Check if pitch matching is available."""
    return PARSELMOUTH_AVAILABLE
