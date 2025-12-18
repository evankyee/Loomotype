"""
Filler word and silence detection for AI video enhancement.

Detects:
- Filler words: um, uh, like, you know, basically, actually, so, etc.
- Long silences: pauses > 1.5 seconds between words
"""

import uuid
from typing import Optional
from loguru import logger


# Common filler words in English
FILLER_WORDS = {
    # Universal fillers
    "um", "uh", "umm", "uhh", "er", "err", "ah", "ahh",
    # Discourse markers used as fillers
    "like", "so", "basically", "actually", "literally",
    "you know", "i mean", "kind of", "sort of",
    # Hesitation markers
    "well", "right", "okay", "ok",
}

# Minimum silence duration to flag (seconds)
SILENCE_THRESHOLD = 1.5


class FillerDetector:
    """
    Detects filler words and long silences from transcript data.

    The detector analyzes word-level timestamps from transcription
    to identify:
    1. Known filler words (um, uh, like, etc.)
    2. Long pauses between words (silence > threshold)
    """

    def __init__(
        self,
        filler_words: Optional[set] = None,
        silence_threshold: float = SILENCE_THRESHOLD,
    ):
        """
        Initialize the filler detector.

        Args:
            filler_words: Custom set of filler words to detect
            silence_threshold: Minimum silence duration to flag (seconds)
        """
        self.filler_words = filler_words or FILLER_WORDS
        self.silence_threshold = silence_threshold

    def detect_fillers(
        self,
        transcript: dict,
        video_duration: float,
    ) -> list[dict]:
        """
        Detect filler words and silences from transcript.

        Args:
            transcript: Transcript dict with segments containing words
                       Format: {"segments": [{"words": [{"text", "start_time", "end_time"}]}]}
            video_duration: Total video duration in seconds

        Returns:
            List of detected fillers with format:
            [{
                "id": str,
                "type": "filler" | "silence",
                "text": str,
                "start": float,
                "end": float
            }]
        """
        fillers = []
        all_words = []

        # Extract all words from segments
        segments = transcript.get("segments", [])
        for segment in segments:
            words = segment.get("words", [])
            for word in words:
                all_words.append({
                    "text": word.get("text", "").strip(),
                    "start": word.get("start_time", 0),
                    "end": word.get("end_time", 0),
                })

        if not all_words:
            logger.warning("No words found in transcript")
            return fillers

        # Detect filler words
        for i, word in enumerate(all_words):
            word_text = word["text"].lower().strip(".,!?;:'\"")

            # Check single word fillers
            if word_text in self.filler_words:
                fillers.append({
                    "id": str(uuid.uuid4())[:8],
                    "type": "filler",
                    "text": word["text"],
                    "start": word["start"],
                    "end": word["end"],
                })
                continue

            # Check multi-word fillers (e.g., "you know", "i mean")
            if i < len(all_words) - 1:
                next_word = all_words[i + 1]["text"].lower().strip(".,!?;:'\"")
                two_word = f"{word_text} {next_word}"
                if two_word in self.filler_words:
                    fillers.append({
                        "id": str(uuid.uuid4())[:8],
                        "type": "filler",
                        "text": f"{word['text']} {all_words[i + 1]['text']}",
                        "start": word["start"],
                        "end": all_words[i + 1]["end"],
                    })

        # Detect long silences
        for i in range(len(all_words) - 1):
            current_end = all_words[i]["end"]
            next_start = all_words[i + 1]["start"]
            gap = next_start - current_end

            if gap >= self.silence_threshold:
                fillers.append({
                    "id": str(uuid.uuid4())[:8],
                    "type": "silence",
                    "text": f"[{gap:.1f}s silence]",
                    "start": current_end,
                    "end": next_start,
                })

        # Also check for silence at the beginning
        if all_words and all_words[0]["start"] >= self.silence_threshold:
            fillers.append({
                "id": str(uuid.uuid4())[:8],
                "type": "silence",
                "text": f"[{all_words[0]['start']:.1f}s silence at start]",
                "start": 0,
                "end": all_words[0]["start"],
            })

        # Check for silence at the end
        if all_words and (video_duration - all_words[-1]["end"]) >= self.silence_threshold:
            end_gap = video_duration - all_words[-1]["end"]
            fillers.append({
                "id": str(uuid.uuid4())[:8],
                "type": "silence",
                "text": f"[{end_gap:.1f}s silence at end]",
                "start": all_words[-1]["end"],
                "end": video_duration,
            })

        # Sort by start time
        fillers.sort(key=lambda x: x["start"])

        logger.info(f"Detected {len(fillers)} fillers/silences")
        return fillers
