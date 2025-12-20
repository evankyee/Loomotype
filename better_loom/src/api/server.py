"""
Soron Video Personalization API

Complete API for video personalization using:
- Google Chirp 3 for transcription
- Google Vision for object/text detection
- ElevenLabs for voice generation
- Sync Labs for lip-sync
- FFmpeg for video compositing

This is the PRODUCTION API - no mock data.
"""

# Load environment variables from .env file BEFORE anything else
from dotenv import load_dotenv
load_dotenv()

import os
import re
import time
import uuid
import shutil
import tempfile
import hashlib
from pathlib import Path
from typing import Optional
from datetime import datetime

import asyncio
import concurrent.futures

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from loguru import logger

from ..core import get_video_info, get_audio_duration, fix_webm_duration
from ..core.ffmpeg_utils import run_ffmpeg, FFmpegProcessor


# Helper function for file hashing (used for debugging/verification)
def get_file_hash(path: Path) -> str:
    """Get MD5 hash prefix of a file for comparison."""
    return hashlib.md5(Path(path).read_bytes()).hexdigest()[:12]


# Voice list cache (avoids repeated API calls to ElevenLabs)
_voices_cache = None
_voices_cache_time = None
VOICES_CACHE_TTL_SECONDS = 300  # 5 minutes


# Initialize FastAPI
app = FastAPI(
    title="Soron Video Personalization",
    description="AI-powered video personalization - record, edit, personalize",
    version="2.0.0",
)

# CORS for web and desktop clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GZIP compression for faster API responses (30-40% smaller)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Storage paths
UPLOAD_DIR = Path(tempfile.gettempdir()) / "soron" / "uploads"
OUTPUT_DIR = Path(tempfile.gettempdir()) / "soron" / "outputs"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Persistent JSON-backed store to survive server restarts
import json
import threading

class PersistentStore:
    """JSON-backed dictionary that persists data to disk."""

    def __init__(self, name: str, directory: Path = None):
        self.name = name
        self.directory = directory or (UPLOAD_DIR / "metadata")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.file_path = self.directory / f"{name}.json"
        self._lock = threading.Lock()
        self._data = self._load()
        logger.info(f"PersistentStore '{name}' initialized with {len(self._data)} entries")

    def _load(self) -> dict:
        """Load data from JSON file."""
        if self.file_path.exists():
            try:
                with open(self.file_path, 'r') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to load {self.file_path}: {e}, starting fresh")
                return {}
        return {}

    def _save(self):
        """Save data to JSON file."""
        try:
            with open(self.file_path, 'w') as f:
                json.dump(self._data, f, indent=2, default=str)
        except IOError as e:
            logger.error(f"Failed to save {self.file_path}: {e}")

    def __getitem__(self, key):
        return self._data[key]

    def __setitem__(self, key, value):
        with self._lock:
            self._data[key] = value
            self._save()

    def __contains__(self, key):
        return key in self._data

    def __delitem__(self, key):
        with self._lock:
            del self._data[key]
            self._save()

    def get(self, key, default=None):
        return self._data.get(key, default)

    def keys(self):
        return self._data.keys()

    def values(self):
        return self._data.values()

    def items(self):
        return self._data.items()

    def update(self, *args, **kwargs):
        with self._lock:
            self._data.update(*args, **kwargs)
            self._save()

# Persistent stores (survives server restarts)
videos_store = PersistentStore("videos")
jobs_store = PersistentStore("jobs")


# ============================================================================
# MODELS
# ============================================================================

class TranscriptWord(BaseModel):
    id: str
    text: str
    start_time: float
    end_time: float
    confidence: float = 1.0


class TranscriptSegment(BaseModel):
    text: str
    start_time: float
    end_time: float
    words: list[TranscriptWord]


class TranscriptResponse(BaseModel):
    segments: list[TranscriptSegment]
    duration: float
    language: str = "en-US"


class DetectedObject(BaseModel):
    id: str
    name: str
    confidence: float
    x: float  # normalized 0-1
    y: float
    width: float
    height: float
    timestamp: float


class DetectedText(BaseModel):
    id: str
    text: str
    confidence: float
    x: float
    y: float
    width: float
    height: float
    timestamp: float


class FrameAnalysis(BaseModel):
    timestamp: float
    objects: list[DetectedObject]
    texts: list[DetectedText]
    logos: list[DetectedObject]


class AnalysisResponse(BaseModel):
    frames: list[FrameAnalysis]
    unique_objects: list[str]
    unique_texts: list[str]


class PersonalizationField(BaseModel):
    """A field that can be personalized in the video."""
    id: str
    name: str  # e.g., "company_name", "recipient_name"
    field_type: str  # "text", "image", "voice"

    # For visual fields
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None

    # For text fields
    font_size: Optional[int] = 48
    font_color: Optional[str] = "white"
    background_color: Optional[str] = None

    # For voice fields
    original_text: Optional[str] = None
    template_text: Optional[str] = None  # e.g., "Hello {name}!"


class VideoTemplate(BaseModel):
    """Template for personalized video."""
    id: str
    name: str
    video_id: str
    voice_id: Optional[str] = None
    fields: list[PersonalizationField] = []
    created_at: str


class TemplateRenderRequest(BaseModel):
    """Request to render a video from a template."""
    template_id: str
    field_values: dict  # e.g., {"company_name": "Acme Corp", "recipient_name": "John"}


class JobStatus(BaseModel):
    job_id: str
    status: str  # "pending", "processing", "completed", "failed"
    progress: int = 0
    output_url: Optional[str] = None
    error: Optional[str] = None


class BubbleVisibility(BaseModel):
    """Time range for bubble visibility."""
    start: float  # seconds
    end: float    # seconds
    visible: bool = True


class BubbleSettings(BaseModel):
    """Settings for camera bubble overlay compositing."""
    position: str = "bottom-left"  # bottom-left, bottom-right, top-left, top-right, custom
    custom_x: Optional[float] = None  # 0-1 normalized (for custom position)
    custom_y: Optional[float] = None  # 0-1 normalized (for custom position)
    size: float = 0.25  # 0-1 as fraction of screen width
    shape: str = "circle"  # circle, square, rounded
    visibility: list[BubbleVisibility] = []  # Time-based visibility (empty = always visible)


class BubbleCompositeRequest(BaseModel):
    """Request to composite camera bubble onto video."""
    bubble_settings: BubbleSettings
    preview: bool = False  # If true, return lower quality for preview


# ============================================================================
# VIDEO UPLOAD & INFO
# ============================================================================

@app.get("/health")
async def health():
    return {"status": "healthy", "version": "2.0.0"}


@app.post("/api/videos/upload")
async def upload_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    camera_file: Optional[UploadFile] = File(None),
    has_embedded_bubble: bool = Form(False),  # True if camera bubble is IN the screen recording
    auto_process: bool = Form(True),  # Auto-run transcription + analysis in background
):
    """
    Upload a video for editing.

    Two approaches for camera:
    1. Separate camera_file: High-quality camera recorded separately
    2. Embedded bubble (has_embedded_bubble=True): Camera bubble is visible in screen recording
       - Simpler, no sync issues
       - Bubble will be cropped for lip-sync

    If auto_process=True (default), automatically runs transcription and vision
    analysis in the background so they're ready when the user opens the editor.
    """
    video_id = str(uuid.uuid4())[:12]

    # Save main screen recording
    video_dir = UPLOAD_DIR / video_id
    video_dir.mkdir(parents=True, exist_ok=True)
    video_path = video_dir / file.filename

    with open(video_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Fix WebM duration if needed (MediaRecorder files often have Infinity duration)
    video_path = fix_webm_duration(video_path)

    # Get video info
    info = get_video_info(video_path)

    # Handle optional camera file for lip-sync
    camera_path = None
    camera_info = None
    if camera_file and camera_file.filename:
        camera_path = video_dir / camera_file.filename
        with open(camera_path, "wb") as f:
            camera_content = await camera_file.read()
            f.write(camera_content)

        # Fix WebM duration for camera file too
        camera_path = fix_webm_duration(camera_path)
        camera_info = get_video_info(camera_path)
        logger.info(f"Camera file uploaded: {camera_path.name} ({camera_info.width}x{camera_info.height}, {camera_info.duration:.1f}s)")

    # If we have a camera file, create an initial preview with camera overlay
    preview_path = None
    if camera_path:
        logger.info(f"Creating initial preview with camera overlay...")
        preview_path = video_dir / f"preview_{video_id}.mp4"
        try:
            FFmpegProcessor.overlay_camera_bubble(
                screen_video=video_path,
                camera_video=camera_path,
                output_path=preview_path,
                position="bottom-left",
                bubble_size=180,
                padding=30,
                use_camera_audio=False,  # Use original screen audio for preview
            )
            logger.info(f"Preview created: {preview_path}")
        except Exception as e:
            logger.error(f"Failed to create preview overlay: {e}")
            preview_path = None

    # Store metadata (use updated path in case file was converted)
    # Embedded bubble constants (must match desktop app)
    BUBBLE_SIZE = 400  # Size of camera bubble when embedded in screen (must match desktop app)
    BUBBLE_PADDING = 30  # Padding from screen edge

    videos_store[video_id] = {
        "id": video_id,
        "filename": video_path.name,
        "path": str(video_path),
        "preview_path": str(preview_path) if preview_path else None,
        "duration": info.duration,
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "uploaded_at": datetime.now().isoformat(),
        "transcript": None,
        "analysis": None,
        "template": None,
        # Camera handling - two approaches:
        # 1. Separate camera file (camera_path set)
        # 2. Embedded bubble (has_embedded_bubble=True, bubble is in screen recording)
        "camera_path": str(camera_path) if camera_path else None,
        "camera_width": camera_info.width if camera_info else None,
        "camera_height": camera_info.height if camera_info else None,
        "has_camera": camera_path is not None,
        "has_embedded_bubble": has_embedded_bubble,  # Camera bubble is IN the screen recording
        "bubble_size": BUBBLE_SIZE if has_embedded_bubble else None,
        "bubble_padding": BUBBLE_PADDING if has_embedded_bubble else None,
        "bubble_position": "bottom-left" if has_embedded_bubble else None,
    }

    camera_mode = "separate file" if camera_path else ("embedded bubble" if has_embedded_bubble else "none")
    logger.info(f"Video uploaded: {video_id} ({info.duration:.1f}s), camera: {camera_mode}")

    # Auto-process: run transcription and analysis in background (parallel)
    if auto_process:
        background_tasks.add_task(auto_process_video, video_id)
        logger.info(f"Auto-processing started for {video_id} (transcription + analysis)")

    return {
        "video_id": video_id,
        "duration": info.duration,
        "width": info.width,
        "height": info.height,
        "url": f"/api/videos/{video_id}/stream",
        "has_camera": camera_path is not None,
        "has_embedded_bubble": has_embedded_bubble,
        "has_preview": preview_path is not None,
        "processing": auto_process,  # Indicates background processing started
    }


async def auto_process_video(video_id: str):
    """
    Background task: Run transcription and vision analysis in parallel.
    Results are cached in videos_store for instant retrieval.
    """
    import asyncio
    import concurrent.futures

    if video_id not in videos_store:
        logger.error(f"Auto-process: Video {video_id} not found")
        return

    video = videos_store[video_id]
    video_path = Path(video["path"])

    logger.info(f"Auto-process starting for {video_id}")

    # Run transcription and analysis in parallel using thread pool
    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        # Submit both tasks
        transcribe_future = loop.run_in_executor(
            executor, _run_transcription_for_cache, video_id, video_path
        )
        analyze_future = loop.run_in_executor(
            executor, _run_analysis_for_cache, video_id, video_path
        )

        # Wait for both to complete
        try:
            await asyncio.gather(transcribe_future, analyze_future)
            logger.info(f"Auto-process completed for {video_id}")
        except Exception as e:
            logger.error(f"Auto-process error for {video_id}: {e}")


def _run_transcription_for_cache(video_id: str, video_path: Path):
    """Run transcription and cache result."""
    try:
        from ..transcription import GoogleSpeechClient

        logger.info(f"[{video_id}] Starting transcription...")
        client = GoogleSpeechClient()
        transcript = client.transcribe_video(video_path)

        # Convert to response format and cache
        segments = []
        for i, seg in enumerate(transcript.segments):
            words = []
            for j, word in enumerate(seg.words):
                words.append({
                    "id": f"w-{i}-{j}",
                    "text": word.text,
                    "start_time": word.start_time,
                    "end_time": word.end_time,
                    "confidence": getattr(word, 'confidence', 1.0),
                })
            segments.append({
                "text": seg.text,
                "start_time": seg.start_time,
                "end_time": seg.end_time,
                "words": words,
            })

        # Cache in videos_store
        video = videos_store[video_id]
        video["transcript"] = {
            "segments": segments,
            "duration": transcript.duration,
            "language": transcript.language,
        }
        videos_store[video_id] = video
        logger.info(f"[{video_id}] Transcription cached ({len(segments)} segments)")

    except Exception as e:
        logger.error(f"[{video_id}] Transcription failed: {e}")


def _run_analysis_for_cache(video_id: str, video_path: Path):
    """Run vision analysis and cache result."""
    try:
        from ..vision import GoogleVisionClient

        logger.info(f"[{video_id}] Starting vision analysis...")
        client = GoogleVisionClient()
        # Use 2-second intervals for faster processing
        frames = client.analyze_video_frames(video_path, interval_seconds=2.0)

        # Convert to response format
        frame_data = []
        unique_objects = set()
        unique_texts = set()

        for frame in frames:
            objects = []
            for obj in frame.objects:
                objects.append({
                    "id": f"obj-{len(frame_data)}-{len(objects)}",
                    "name": obj.name,
                    "confidence": obj.confidence,
                    "x": obj.bounding_box.x,
                    "y": obj.bounding_box.y,
                    "width": obj.bounding_box.width,
                    "height": obj.bounding_box.height,
                    "timestamp": frame.timestamp,
                })
                unique_objects.add(obj.name)

            texts = []
            for txt in frame.texts:
                texts.append({
                    "id": f"txt-{len(frame_data)}-{len(texts)}",
                    "text": txt.text,
                    "confidence": txt.confidence,
                    "x": txt.bounding_box.x,
                    "y": txt.bounding_box.y,
                    "width": txt.bounding_box.width,
                    "height": txt.bounding_box.height,
                    "timestamp": frame.timestamp,
                })
                unique_texts.add(txt.text)

            logos = []
            for logo in frame.logos:
                logos.append({
                    "id": f"logo-{len(frame_data)}-{len(logos)}",
                    "name": logo.text if hasattr(logo, 'text') else logo.name,
                    "confidence": logo.confidence,
                    "x": logo.bounding_box.x,
                    "y": logo.bounding_box.y,
                    "width": logo.bounding_box.width,
                    "height": logo.bounding_box.height,
                    "timestamp": frame.timestamp,
                })

            frame_data.append({
                "timestamp": frame.timestamp,
                "objects": objects,
                "texts": texts,
                "logos": logos,
            })

        # Cache in videos_store
        video = videos_store[video_id]
        video["analysis"] = {
            "frames": frame_data,
            "unique_objects": list(unique_objects),
            "unique_texts": list(unique_texts),
        }
        videos_store[video_id] = video
        logger.info(f"[{video_id}] Analysis cached ({len(frame_data)} frames)")

    except Exception as e:
        logger.error(f"[{video_id}] Analysis failed: {e}")


@app.get("/api/videos/{video_id}")
async def get_video(video_id: str):
    """Get video metadata."""
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")
    return videos_store[video_id]


@app.get("/api/videos/{video_id}/stream")
async def stream_video(video_id: str):
    """Stream video file. Serves preview (with camera overlay) if available."""
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]

    # Prefer preview (has camera overlay) if available
    video_path = video.get("preview_path") or video["path"]
    filename = Path(video_path).name

    # Determine media type from file extension
    media_type = "video/mp4"
    if filename.endswith(".webm"):
        media_type = "video/webm"

    return FileResponse(
        video_path,
        media_type=media_type,
        filename=filename,
    )


@app.get("/api/videos")
async def list_videos():
    """List all uploaded videos."""
    return list(videos_store.values())


# ============================================================================
# TRANSCRIPTION (Google Chirp 3)
# ============================================================================

@app.post("/api/videos/{video_id}/transcribe", response_model=TranscriptResponse)
async def transcribe_video(video_id: str):
    """
    Transcribe video using Google Chirp 3.
    Returns word-level timestamps.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    try:
        from ..transcription import GoogleSpeechClient

        client = GoogleSpeechClient()
        transcript = client.transcribe_video(video_path)

        # Convert to response format
        segments = []
        for i, seg in enumerate(transcript.segments):
            words = []
            for j, word in enumerate(seg.words):
                words.append(TranscriptWord(
                    id=f"w-{i}-{j}",
                    text=word.text,
                    start_time=word.start_time,
                    end_time=word.end_time,
                    confidence=word.confidence,
                ))

            segments.append(TranscriptSegment(
                text=seg.text,
                start_time=seg.start_time,
                end_time=seg.end_time,
                words=words,
            ))

        response = TranscriptResponse(
            segments=segments,
            duration=transcript.duration,
            language=transcript.language,
        )

        # Store with video (re-assign to trigger persistent save)
        video = videos_store[video_id]
        video["transcript"] = response.model_dump()
        videos_store[video_id] = video

        logger.info(f"Transcribed video {video_id}: {len(segments)} segments")
        return response

    except Exception as e:
        logger.exception(f"Transcription failed for {video_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/videos/{video_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(video_id: str):
    """Get stored transcript."""
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    if not video.get("transcript"):
        raise HTTPException(status_code=404, detail="Transcript not found. Call /transcribe first.")

    return TranscriptResponse(**video["transcript"])


# ============================================================================
# VISION ANALYSIS (Google Vision API)
# ============================================================================

@app.post("/api/videos/{video_id}/analyze", response_model=AnalysisResponse)
async def analyze_video(video_id: str, interval: float = 2.0):
    """
    Analyze video frames for objects, text, and logos.
    Uses Google Vision API.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    try:
        from ..vision import GoogleVisionClient

        client = GoogleVisionClient()
        analyses = client.analyze_video_frames(video_path, interval_seconds=interval)

        # Convert to response format
        frames = []
        unique_objects = set()
        unique_texts = set()

        for i, analysis in enumerate(analyses):
            objects = []
            for j, obj in enumerate(analysis.objects):
                objects.append(DetectedObject(
                    id=f"obj-{i}-{j}",
                    name=obj.name,
                    confidence=obj.confidence,
                    x=obj.bounding_box.x if obj.bounding_box else 0,
                    y=obj.bounding_box.y if obj.bounding_box else 0,
                    width=obj.bounding_box.width if obj.bounding_box else 0,
                    height=obj.bounding_box.height if obj.bounding_box else 0,
                    timestamp=analysis.frame_time,
                ))
                unique_objects.add(obj.name)

            texts = []
            for j, text in enumerate(analysis.texts):
                if len(text.text) > 2:  # Skip very short text
                    texts.append(DetectedText(
                        id=f"txt-{i}-{j}",
                        text=text.text[:100],  # Truncate long text
                        confidence=text.confidence,
                        x=text.bounding_box.x if text.bounding_box else 0,
                        y=text.bounding_box.y if text.bounding_box else 0,
                        width=text.bounding_box.width if text.bounding_box else 0,
                        height=text.bounding_box.height if text.bounding_box else 0,
                        timestamp=analysis.frame_time,
                    ))
                    unique_texts.add(text.text[:50])

            logos = []
            for j, logo in enumerate(analysis.logos):
                logos.append(DetectedObject(
                    id=f"logo-{i}-{j}",
                    name=logo.name,
                    confidence=logo.confidence,
                    x=logo.bounding_box.x if logo.bounding_box else 0,
                    y=logo.bounding_box.y if logo.bounding_box else 0,
                    width=logo.bounding_box.width if logo.bounding_box else 0,
                    height=logo.bounding_box.height if logo.bounding_box else 0,
                    timestamp=analysis.frame_time,
                ))
                unique_objects.add(f"Logo: {logo.name}")

            frames.append(FrameAnalysis(
                timestamp=analysis.frame_time,
                objects=objects,
                texts=texts,
                logos=logos,
            ))

        response = AnalysisResponse(
            frames=frames,
            unique_objects=list(unique_objects),
            unique_texts=list(unique_texts)[:20],  # Limit to 20
        )

        # Store with video (re-assign to trigger persistent save)
        video = videos_store[video_id]
        video["analysis"] = response.model_dump()
        videos_store[video_id] = video

        logger.info(f"Analyzed video {video_id}: {len(frames)} frames, {len(unique_objects)} objects")
        return response

    except Exception as e:
        logger.exception(f"Analysis failed for {video_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/videos/{video_id}/analysis", response_model=AnalysisResponse)
async def get_analysis(video_id: str):
    """Get stored analysis."""
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    if not video.get("analysis"):
        raise HTTPException(status_code=404, detail="Analysis not found. Call /analyze first.")

    return AnalysisResponse(**video["analysis"])


# ============================================================================
# PARALLEL PROCESSING (Transcription + Vision in parallel)
# ============================================================================

# Thread pool for running sync operations in parallel
_process_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def _run_transcription_sync(video_id: str, video_path: Path) -> dict:
    """Synchronous transcription for thread pool execution."""
    from ..transcription import GoogleSpeechClient

    client = GoogleSpeechClient()
    transcript = client.transcribe_video(video_path)

    # Convert to serializable format
    segments = []
    for i, seg in enumerate(transcript.segments):
        words = []
        for j, word in enumerate(seg.words):
            words.append({
                "id": f"w-{i}-{j}",
                "text": word.text,
                "start_time": word.start_time,
                "end_time": word.end_time,
                "confidence": word.confidence,
            })
        segments.append({
            "text": seg.text,
            "start_time": seg.start_time,
            "end_time": seg.end_time,
            "words": words,
        })

    return {
        "segments": segments,
        "duration": transcript.duration,
        "language": transcript.language,
    }


def _run_analysis_sync(video_id: str, video_path: Path, interval: float) -> dict:
    """Synchronous vision analysis for thread pool execution."""
    from ..vision import GoogleVisionClient

    client = GoogleVisionClient()
    analyses = client.analyze_video_frames(video_path, interval_seconds=interval)

    # Convert to serializable format
    frames = []
    unique_objects = set()
    unique_texts = set()

    for i, analysis in enumerate(analyses):
        objects = []
        for j, obj in enumerate(analysis.objects):
            objects.append({
                "id": f"obj-{i}-{j}",
                "name": obj.name,
                "confidence": obj.confidence,
                "x": obj.bounding_box.x if obj.bounding_box else 0,
                "y": obj.bounding_box.y if obj.bounding_box else 0,
                "width": obj.bounding_box.width if obj.bounding_box else 0,
                "height": obj.bounding_box.height if obj.bounding_box else 0,
                "timestamp": analysis.frame_time,
            })
            unique_objects.add(obj.name)

        texts = []
        for j, text in enumerate(analysis.texts):
            if len(text.text) > 2:
                texts.append({
                    "id": f"txt-{i}-{j}",
                    "text": text.text[:100],
                    "confidence": text.confidence,
                    "x": text.bounding_box.x if text.bounding_box else 0,
                    "y": text.bounding_box.y if text.bounding_box else 0,
                    "width": text.bounding_box.width if text.bounding_box else 0,
                    "height": text.bounding_box.height if text.bounding_box else 0,
                    "timestamp": analysis.frame_time,
                })
                unique_texts.add(text.text[:50])

        logos = []
        for j, logo in enumerate(analysis.logos):
            logos.append({
                "id": f"logo-{i}-{j}",
                "name": logo.name,
                "confidence": logo.confidence,
                "x": logo.bounding_box.x if logo.bounding_box else 0,
                "y": logo.bounding_box.y if logo.bounding_box else 0,
                "width": logo.bounding_box.width if logo.bounding_box else 0,
                "height": logo.bounding_box.height if logo.bounding_box else 0,
                "timestamp": analysis.frame_time,
            })
            unique_objects.add(f"Logo: {logo.name}")

        frames.append({
            "timestamp": analysis.frame_time,
            "objects": objects,
            "texts": texts,
            "logos": logos,
        })

    return {
        "frames": frames,
        "unique_objects": list(unique_objects),
        "unique_texts": list(unique_texts)[:20],
    }


@app.post("/api/videos/{video_id}/process")
async def process_video_parallel(video_id: str, interval: float = 2.0):
    """
    Process video with transcription AND vision analysis in PARALLEL.

    This is 33% faster than calling /transcribe and /analyze sequentially.
    Use this instead of separate calls for better performance.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    logger.info(f"Starting parallel processing for video {video_id}")
    start_time = time.time()

    loop = asyncio.get_event_loop()

    try:
        # Run transcription and analysis in parallel using thread pool
        transcription_future = loop.run_in_executor(
            _process_executor,
            _run_transcription_sync,
            video_id,
            video_path,
        )
        analysis_future = loop.run_in_executor(
            _process_executor,
            _run_analysis_sync,
            video_id,
            video_path,
            interval,
        )

        # Wait for both to complete
        transcript_data, analysis_data = await asyncio.gather(
            transcription_future,
            analysis_future,
        )

        elapsed = time.time() - start_time
        logger.info(f"Parallel processing completed in {elapsed:.1f}s")

        # Store results
        video = videos_store[video_id]
        video["transcript"] = transcript_data
        video["analysis"] = analysis_data
        videos_store[video_id] = video

        return {
            "transcript": transcript_data,
            "analysis": analysis_data,
            "processing_time_seconds": round(elapsed, 2),
        }

    except Exception as e:
        logger.exception(f"Parallel processing failed for {video_id}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# VOICE SERVICES (ElevenLabs)
# ============================================================================

@app.get("/api/voices")
async def list_voices():
    """List available ElevenLabs voices (cached for 5 minutes)."""
    global _voices_cache, _voices_cache_time

    # Check if cache is valid
    now = datetime.now()
    if _voices_cache is not None and _voices_cache_time is not None:
        age = (now - _voices_cache_time).total_seconds()
        if age < VOICES_CACHE_TTL_SECONDS:
            logger.debug(f"Returning cached voices (age: {age:.0f}s)")
            return _voices_cache

    try:
        from ..voice import VoiceClient
        client = VoiceClient()
        voices = client.list_voices()

        # Update cache
        _voices_cache = voices
        _voices_cache_time = now
        logger.info(f"Refreshed voices cache ({len(voices.get('voices', []))} voices)")

        return voices
    except Exception as e:
        logger.exception("Failed to list voices")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/videos/{video_id}/clone-voice")
async def clone_voice(
    video_id: str,
    name: str = Form("Cloned Voice"),
    method: str = Form("pvc"),  # "pvc" (Pro) or "ivc" (Instant)
):
    """
    Clone voice from video speaker using ElevenLabs Pro.

    Methods:
    - pvc: Professional Voice Cloning (highest quality, Pro plan)
    - ivc: Instant Voice Cloning (faster, good quality)
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    try:
        from ..voice import VoiceClient
        import subprocess
        import re

        # Step 1: Detect when speech starts (skip initial silence)
        # Use silencedetect to find the end of the first silence period
        silence_result = subprocess.run([
            "ffmpeg", "-i", str(video_path),
            "-af", "silencedetect=noise=-30dB:d=0.5",
            "-f", "null", "-"
        ], capture_output=True, text=True)

        # Parse silence_end from stderr (FFmpeg outputs filter info to stderr)
        speech_start = 0.0
        silence_end_match = re.search(r"silence_end:\s*([\d.]+)", silence_result.stderr)
        if silence_end_match:
            speech_start = float(silence_end_match.group(1))
            logger.info(f"Detected speech starts at {speech_start:.2f}s (skipping initial silence)")
        else:
            logger.info("No initial silence detected, starting from beginning")

        # Step 2: Extract 90 seconds of audio starting from speech start
        # Use WAV 48kHz for highest quality voice cloning
        # PVC (Pro) benefits from clean, uncompressed audio samples
        audio_path = video_path.parent / "voice_sample.wav"
        result = subprocess.run([
            "ffmpeg", "-y",
            "-ss", str(speech_start),  # Start from when speech begins
            "-i", str(video_path),
            "-vn",  # No video
            "-acodec", "pcm_s16le",  # Uncompressed PCM (no lossy compression)
            "-ar", "48000",  # Professional sample rate
            "-ac", "1",  # Mono
            "-t", "90",  # 1 minute 30 seconds
            str(audio_path)
        ], capture_output=True, text=True)

        if result.returncode != 0:
            logger.error(f"FFmpeg audio extraction failed: {result.stderr}")
            raise HTTPException(status_code=500, detail=f"Audio extraction failed: {result.stderr}")

        # Verify audio file exists and has content
        if not audio_path.exists() or audio_path.stat().st_size < 1000:
            raise HTTPException(status_code=500, detail="Audio extraction produced empty or invalid file")

        logger.info(f"Extracted audio: {audio_path} ({audio_path.stat().st_size} bytes), starting at {speech_start:.2f}s")

        # Clone voice using selected method (PVC for Pro, IVC for Instant)
        client = VoiceClient()
        clone_method = method.lower() if method.lower() in ["pvc", "ivc"] else "pvc"
        logger.info(f"Cloning voice using {clone_method.upper()} method")
        voice_id = client.clone_voice(name, [str(audio_path)], method=clone_method)

        # Store with video (re-assign to trigger persistent save)
        video = videos_store[video_id]
        video["voice_id"] = voice_id
        videos_store[video_id] = video

        logger.info(f"Cloned voice for {video_id}: {voice_id} (method: {clone_method.upper()})")
        return {"voice_id": voice_id, "name": name, "method": clone_method.upper()}

    except Exception as e:
        logger.exception(f"Voice cloning failed for {video_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/voice/generate")
async def generate_voice(
    text: str = Form(...),
    voice_id: str = Form(...),
    target_duration: Optional[float] = Form(None),
):
    """Generate speech from text."""
    try:
        from ..voice import VoiceClient

        client = VoiceClient()

        # Generate audio
        audio_id = str(uuid.uuid4())[:8]
        audio_path = OUTPUT_DIR / f"speech_{audio_id}.wav"

        audio_path = client.generate(
            text=text,
            voice_id=voice_id,
            output_path=audio_path,
        )

        # Time-stretch if needed
        duration = get_audio_duration(audio_path)

        if target_duration and abs(duration - target_duration) > 0.1:
            from ..core.ffmpeg_utils import FFmpegProcessor
            stretched_path = OUTPUT_DIR / f"speech_{audio_id}_stretched.wav"
            FFmpegProcessor.time_stretch_audio(
                audio_path=str(audio_path),
                target_duration=target_duration,
                output_path=str(stretched_path),
            )
            audio_path = stretched_path
            duration = target_duration

        return {
            "audio_id": audio_id,
            "audio_url": f"/api/audio/{audio_path.stem}",
            "duration": duration,
        }

    except Exception as e:
        logger.exception("Voice generation failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    """Get generated audio file."""
    for ext in [".wav", ".mp3"]:
        audio_path = OUTPUT_DIR / f"{audio_id}{ext}"
        if audio_path.exists():
            return FileResponse(str(audio_path), media_type="audio/wav")

    raise HTTPException(status_code=404, detail="Audio not found")


# ============================================================================
# TEMPLATES & PERSONALIZATION
# ============================================================================

templates_store = PersistentStore("templates")


@app.post("/api/templates")
async def create_template(
    video_id: str = Form(...),
    name: str = Form(...),
    fields: str = Form("[]"),  # JSON string of PersonalizationField[]
):
    """Create a personalization template."""
    import json

    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    template_id = str(uuid.uuid4())[:8]

    # Parse fields
    try:
        fields_data = json.loads(fields)
        parsed_fields = [PersonalizationField(**f) for f in fields_data]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid fields: {e}")

    template = VideoTemplate(
        id=template_id,
        name=name,
        video_id=video_id,
        voice_id=videos_store[video_id].get("voice_id"),
        fields=parsed_fields,
        created_at=datetime.now().isoformat(),
    )

    templates_store[template_id] = template.model_dump()

    # Store with video (re-assign to trigger persistent save)
    video = videos_store[video_id]
    video["template"] = template_id
    videos_store[video_id] = video

    logger.info(f"Created template {template_id} for video {video_id}")
    return template


@app.get("/api/templates/{template_id}")
async def get_template(template_id: str):
    """Get template details."""
    if template_id not in templates_store:
        raise HTTPException(status_code=404, detail="Template not found")
    return templates_store[template_id]


# ============================================================================
# VISUAL REPLACEMENT - Direct rendering with detected elements
# ============================================================================

class TextReplacement(BaseModel):
    """A text replacement instruction."""
    original_text: str
    new_text: str
    x: float  # Percentage 0-100
    y: float
    width: float
    height: float
    start_time: float
    end_time: float
    font_color: Optional[str] = "white"
    bg_color: Optional[str] = None  # None = sample from video


class RenderRequest(BaseModel):
    """Request to render personalized video."""
    video_id: str
    text_replacements: list[TextReplacement] = []
    voice_edits: list[dict] = []  # For voice replacement with lip-sync


@app.post("/api/videos/{video_id}/render")
async def render_personalized_video(
    video_id: str,
    request: RenderRequest,
    background_tasks: BackgroundTasks,
):
    """
    Render a personalized video with text/visual replacements.

    Uses OpenCV-based VisualReplacer for native-looking replacements.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    # Create render job
    job_id = str(uuid.uuid4())[:8]
    output_filename = f"render_{job_id}.mp4"
    output_path = OUTPUT_DIR / output_filename

    jobs_store[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background rendering
    background_tasks.add_task(
        process_visual_render,
        job_id,
        video_path,
        output_path,
        request.text_replacements,
        request.voice_edits,
    )

    return {"job_id": job_id, "status": "pending", "progress": 0}


@app.post("/api/videos/{video_id}/composite-bubble")
async def composite_bubble(
    video_id: str,
    request: BubbleCompositeRequest,
    background_tasks: BackgroundTasks,
):
    """
    Composite camera bubble onto video with custom settings.

    Requires a video that was uploaded with a separate camera file.
    Allows adjusting position, size, shape, and time-based visibility.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]

    if not video.get("camera_path"):
        raise HTTPException(
            status_code=400,
            detail="No separate camera file for this video. Bubble compositing only works with videos recorded in window mode."
        )

    video_path = Path(video["path"])
    camera_path = Path(video["camera_path"])

    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")
    if not camera_path.exists():
        raise HTTPException(status_code=404, detail="Camera file not found")

    # Create job
    job_id = str(uuid.uuid4())[:8]
    quality = "preview" if request.preview else "final"
    output_filename = f"composite_{job_id}_{quality}.mp4"
    output_path = OUTPUT_DIR / output_filename

    jobs_store[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background compositing
    background_tasks.add_task(
        process_bubble_composite,
        job_id,
        video_path,
        camera_path,
        output_path,
        request.bubble_settings,
        request.preview,
    )

    return {"job_id": job_id, "status": "pending", "progress": 0}


async def process_bubble_composite(
    job_id: str,
    video_path: Path,
    camera_path: Path,
    output_path: Path,
    settings: BubbleSettings,
    preview: bool,
):
    """Background task to composite camera bubble onto video."""
    try:
        from ..core.ffmpeg_utils import FFmpegProcessor

        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 10

        # Get video info for calculating positions
        info = get_video_info(video_path)
        width, height = info.width, info.height

        # Calculate bubble size in pixels
        bubble_size = int(width * settings.size)
        padding = 30

        # Calculate position
        if settings.position == "custom" and settings.custom_x is not None and settings.custom_y is not None:
            x = int(settings.custom_x * width)
            y = int(settings.custom_y * height)
        else:
            # Predefined positions
            positions = {
                "bottom-left": (padding, height - bubble_size - padding),
                "bottom-right": (width - bubble_size - padding, height - bubble_size - padding),
                "top-left": (padding, padding),
                "top-right": (width - bubble_size - padding, padding),
            }
            x, y = positions.get(settings.position, positions["bottom-left"])

        jobs_store[job_id]["progress"] = 30

        # Build visibility filter if time-based visibility is set
        visibility_filter = None
        if settings.visibility:
            # Build enable expression for time-based visibility
            enable_parts = []
            for v in settings.visibility:
                if v.visible:
                    enable_parts.append(f"between(t,{v.start},{v.end})")
            if enable_parts:
                visibility_filter = "+".join(enable_parts)

        jobs_store[job_id]["progress"] = 50

        # Use FFmpegProcessor for compositing
        FFmpegProcessor.overlay_camera_bubble(
            screen_video=video_path,
            camera_video=camera_path,
            output_path=output_path,
            position=settings.position if settings.position != "custom" else "custom",
            bubble_size=bubble_size,
            padding=padding,
            shape=settings.shape,
            custom_x=x if settings.position == "custom" else None,
            custom_y=y if settings.position == "custom" else None,
            visibility_filter=visibility_filter,
            quality="fast" if preview else "balanced",
        )

        jobs_store[job_id]["progress"] = 90

        # Update job with output URL
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["output_url"] = f"/api/output/{output_path.name}"

        # Update video store with latest composite
        video = videos_store[video_path.parent.name] if video_path.parent.name in videos_store else None
        if video:
            video["latest_composite"] = str(output_path)
            video["bubble_settings"] = settings.model_dump()

        logger.info(f"Bubble composite completed: {output_path}")

    except Exception as e:
        logger.exception(f"Bubble composite failed for job {job_id}")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


async def process_visual_render(
    job_id: str,
    video_path: Path,
    output_path: Path,
    text_replacements: list[TextReplacement],
    voice_edits: list[dict],
):
    """Background task to render personalized video."""
    try:
        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 10

        from ..visual.replacer import VisualReplacer
        from ..visual.tracker import BoundingBox
        from ..models import VisualSegment, SegmentType

        replacer = VisualReplacer()

        # Get video info
        info = get_video_info(video_path)
        frame_width = info.width
        frame_height = info.height

        jobs_store[job_id]["progress"] = 20

        # Create visual segments and assets from text replacements
        segments = []
        assets = {}
        segment_info = {}  # Store info for color sampling

        for i, replacement in enumerate(text_replacements):
            segment_id = f"text_{i}"

            # Convert percentage to normalized (0-1)
            segment = VisualSegment(
                id=segment_id,
                segment_type=SegmentType.TEXT,
                start_time=replacement.start_time,
                end_time=replacement.end_time,
                x=replacement.x / 100,  # Convert to 0-1
                y=replacement.y / 100,
                width=replacement.width / 100,
                height=replacement.height / 100,
                placeholder_key=segment_id,
                tracking_reference_frame=None,  # Static replacement
            )
            segments.append(segment)

            # Create text asset
            pixel_width = int(replacement.width * frame_width / 100)
            pixel_height = int(replacement.height * frame_height / 100)

            # Store segment info for later color sampling
            segment_info[segment_id] = {
                "replacement": replacement,
                "pixel_width": pixel_width,
                "pixel_height": pixel_height,
            }

        # Sample colors from the first frame of the video
        import cv2
        cap = cv2.VideoCapture(str(video_path))
        if cap.isOpened():
            ret, first_frame = cap.read()
            cap.release()

            if ret:
                from ..visual.tracker import BoundingBox

                for segment_id, info in segment_info.items():
                    replacement = info["replacement"]

                    # Create bbox for color sampling (normalized 0-1)
                    bbox = BoundingBox(
                        x=replacement.x / 100,
                        y=replacement.y / 100,
                        width=replacement.width / 100,
                        height=replacement.height / 100,
                    )

                    # Sample background and text colors
                    bg_color = replacer.sample_background_color(first_frame, bbox)
                    text_color = replacer.sample_text_color(first_frame, bbox)

                    logger.info(
                        f"Sampled colors for '{replacement.original_text}': "
                        f"bg=RGB{bg_color}, text=RGB{text_color}"
                    )

                    # Create text asset with sampled colors and auto-scaling
                    asset = replacer.create_text_asset(
                        text=replacement.new_text,
                        width=info["pixel_width"],
                        height=info["pixel_height"],
                        font_size=None,  # Auto-scale to fit
                        color=text_color,
                        bg_color=bg_color,
                        align="left",  # UI text is usually left-aligned
                    )
                    assets[segment_id] = asset

                    logger.info(
                        f"Created replacement: '{replacement.original_text}' → '{replacement.new_text}' "
                        f"at ({replacement.x}, {replacement.y})"
                    )
            else:
                # Fallback if can't read frame - use defaults
                for segment_id, info in segment_info.items():
                    replacement = info["replacement"]
                    asset = replacer.create_text_asset(
                        text=replacement.new_text,
                        width=info["pixel_width"],
                        height=info["pixel_height"],
                        font_size=None,
                        color=(255, 255, 255),
                        bg_color=None,
                    )
                    assets[segment_id] = asset
        else:
            # Fallback if can't open video
            for segment_id, info in segment_info.items():
                replacement = info["replacement"]
                asset = replacer.create_text_asset(
                    text=replacement.new_text,
                    width=info["pixel_width"],
                    height=info["pixel_height"],
                    font_size=None,
                    color=(255, 255, 255),
                    bg_color=None,
                )
                assets[segment_id] = asset

        jobs_store[job_id]["progress"] = 40

        if segments:
            # Process video with replacements
            logger.info(f"Rendering {len(segments)} visual replacements")
            replacer.process_video(
                video_path=video_path,
                segments=segments,
                assets=assets,
                output_path=output_path,
            )
            jobs_store[job_id]["progress"] = 80
        else:
            # No replacements, just copy
            import shutil
            shutil.copy(video_path, output_path)

        # TODO: Apply voice edits with lip-sync if provided
        if voice_edits:
            logger.warning("Voice edits with lip-sync not yet implemented in render")

        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["output_path"] = str(output_path)  # Save path for preview endpoint
        jobs_store[job_id]["output_url"] = f"/api/render/{job_id}/download"

        logger.info(f"Render complete: {output_path}")

    except Exception as e:
        logger.exception("Render failed")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


@app.get("/api/render/{job_id}/download")
async def download_render(job_id: str):
    """Download rendered video."""
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_store[job_id]
    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Job status: {job['status']}")

    output_path = OUTPUT_DIR / f"render_{job_id}.mp4"
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Render output not found")

    return FileResponse(
        str(output_path),
        media_type="video/mp4",
        filename=f"personalized_{job_id}.mp4",
    )


@app.get("/api/templates")
async def list_templates():
    """List all templates."""
    return list(templates_store.values())


# ============================================================================
# RENDER PERSONALIZED VIDEO
# ============================================================================

@app.post("/api/render")
async def render_video(
    request: TemplateRenderRequest,
    background_tasks: BackgroundTasks,
):
    """
    Render a personalized video from a template.

    Applies:
    - Voice changes with lip-sync
    - Visual replacements (text, images)

    Runs in background - poll /api/jobs/{job_id} for status.
    """
    if request.template_id not in templates_store:
        raise HTTPException(status_code=404, detail="Template not found")

    template = templates_store[request.template_id]
    video_id = template["video_id"]

    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    job_id = str(uuid.uuid4())[:12]

    jobs_store[job_id] = {
        "job_id": job_id,
        "template_id": request.template_id,
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background processing
    background_tasks.add_task(
        process_render_job,
        job_id,
        template,
        videos_store[video_id],
        request.field_values,
    )

    return JobStatus(job_id=job_id, status="pending", progress=0)


async def process_render_job(
    job_id: str,
    template: dict,
    video: dict,
    field_values: dict,
):
    """Process video rendering in background."""
    try:
        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 10

        from ..personalization_engine import (
            PersonalizationEngine,
            TranscriptEdit,
            VisualEdit,
            ReplacementType,
        )

        engine = PersonalizationEngine()
        video_path = Path(video["path"])

        # Analyze video (quick)
        jobs_store[job_id]["progress"] = 20
        job = engine.analyze_video(video_path, transcribe=False, detect_objects=False)
        job.voice_id = template.get("voice_id")

        # Process fields
        jobs_store[job_id]["progress"] = 30

        for field in template.get("fields", []):
            field_value = field_values.get(field["name"])
            if not field_value:
                continue

            if field["field_type"] == "voice":
                # Voice replacement with lip-sync
                if field.get("template_text"):
                    # Replace template variables
                    new_text = field["template_text"]
                    for key, value in field_values.items():
                        new_text = new_text.replace(f"{{{key}}}", str(value))

                    job.transcript_edits.append(TranscriptEdit(
                        start_time=field.get("start_time", 0),
                        end_time=field.get("end_time", 5),
                        original_text=field.get("original_text", ""),
                        new_text=new_text,
                    ))

            elif field["field_type"] == "text":
                # Text overlay
                job.visual_edits.append(VisualEdit(
                    x=field.get("x", 0.05),
                    y=field.get("y", 0.05),
                    width=field.get("width", 0.3),
                    height=field.get("height", 0.1),
                    start_time=field.get("start_time", 0),
                    end_time=field.get("end_time", video["duration"]),
                    edit_type=ReplacementType.TEXT,
                    new_content=str(field_value),
                    font_size=field.get("font_size", 48),
                    font_color=field.get("font_color", "white"),
                    background_color=field.get("background_color"),
                ))

            elif field["field_type"] == "image":
                # Image overlay
                job.visual_edits.append(VisualEdit(
                    x=field.get("x", 0.05),
                    y=field.get("y", 0.05),
                    width=field.get("width", 0.2),
                    height=field.get("height", 0.2),
                    start_time=field.get("start_time", 0),
                    end_time=field.get("end_time", video["duration"]),
                    edit_type=ReplacementType.IMAGE,
                    new_content=str(field_value),  # Image URL or path
                ))

        # Process
        jobs_store[job_id]["progress"] = 50

        output_path = OUTPUT_DIR / f"render_{job_id}.mp4"
        result_path = engine.process(job, output_path)

        jobs_store[job_id]["progress"] = 90

        # Complete
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["output_url"] = f"/api/jobs/{job_id}/download"
        jobs_store[job_id]["output_path"] = str(result_path)

        logger.info(f"Render job {job_id} completed")

        engine.cleanup()

    except Exception as e:
        logger.exception(f"Render job {job_id} failed")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


@app.get("/api/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str):
    """Get job status."""
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_store[job_id]
    return JobStatus(
        job_id=job["job_id"],
        status=job["status"],
        progress=job["progress"],
        output_url=job.get("output_url"),
        error=job.get("error"),
    )


@app.get("/api/jobs/{job_id}/preview")
async def preview_job_output(job_id: str, request: Request):
    """
    Stream preview of rendered video (for in-editor playback).
    This doesn't save the file - just streams for preview.
    """
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_store[job_id]

    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail="Job not completed")

    output_path = job.get("output_path")
    if not output_path or not Path(output_path).exists():
        raise HTTPException(status_code=404, detail="Output file not found")

    # Stream the preview video (supports seeking)
    file_path = Path(output_path)
    file_size = file_path.stat().st_size

    # Handle range requests for video seeking
    range_header = request.headers.get("range")
    if range_header:
        range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if range_match:
            start = int(range_match.group(1))
            end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
            end = min(end, file_size - 1)

            def iter_file():
                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk_size = min(8192, remaining)
                        data = f.read(chunk_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            return StreamingResponse(
                iter_file(),
                status_code=206,
                media_type="video/mp4",
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(end - start + 1),
                },
            )

    return FileResponse(
        output_path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )


@app.post("/api/jobs/{job_id}/save")
async def save_job_output(job_id: str):
    """
    Save the preview to a permanent location.
    Call this when user clicks "Save" to persist the video.
    """
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_store[job_id]

    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail="Job not completed")

    output_path = job.get("output_path")
    if not output_path or not Path(output_path).exists():
        raise HTTPException(status_code=404, detail="Output file not found")

    # Create permanent save directory
    save_dir = Path("saved_videos")
    save_dir.mkdir(exist_ok=True)

    # Copy to permanent location with timestamp
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    saved_filename = f"personalized_{job_id}_{timestamp}.mp4"
    saved_path = save_dir / saved_filename

    import shutil
    shutil.copy(output_path, saved_path)

    logger.info(f"Saved video to permanent location: {saved_path}")

    return {
        "status": "saved",
        "saved_path": str(saved_path),
        "filename": saved_filename,
        "download_url": f"/api/saved/{saved_filename}",
    }


@app.get("/api/saved/{filename}")
async def download_saved_video(filename: str):
    """Download a permanently saved video."""
    save_dir = Path("saved_videos")
    file_path = save_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Prevent path traversal
    if not file_path.resolve().is_relative_to(save_dir.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=filename,
    )


@app.get("/api/jobs/{job_id}/download")
async def download_job_output(job_id: str):
    """Download rendered video (direct download, doesn't save permanently)."""
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_store[job_id]

    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail="Job not completed")

    output_path = job.get("output_path")
    if not output_path or not Path(output_path).exists():
        raise HTTPException(status_code=404, detail="Output file not found")

    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=f"personalized_{job_id}.mp4",
    )


@app.get("/api/jobs")
async def list_jobs():
    """List all jobs."""
    return list(jobs_store.values())


# ============================================================================
# LIP-SYNC (Wav2Lip - Free, Local)
# ============================================================================

class LipSyncRequest(BaseModel):
    """Request for lip-sync processing."""
    audio_url: Optional[str] = None  # URL to audio file
    audio_path: Optional[str] = None  # Local path to audio
    text: Optional[str] = None  # Text to generate speech for (requires voice_id)
    voice_id: Optional[str] = None  # ElevenLabs voice for TTS
    start_time: float = 0
    end_time: Optional[float] = None


@app.post("/api/videos/{video_id}/lipsync")
async def apply_lipsync(
    video_id: str,
    request: LipSyncRequest,
    background_tasks: BackgroundTasks,
):
    """
    Apply lip-sync to video using Wav2Lip (free, local).

    Can either:
    1. Use provided audio file (audio_url or audio_path)
    2. Generate audio from text using ElevenLabs (requires text + voice_id)
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    # Create job
    job_id = str(uuid.uuid4())[:8]
    output_path = OUTPUT_DIR / f"lipsync_{job_id}.mp4"

    jobs_store[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "type": "lipsync",
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background processing
    background_tasks.add_task(
        process_lipsync_job,
        job_id,
        video_path,
        output_path,
        request,
    )

    return {"job_id": job_id, "status": "pending", "progress": 0}


async def process_lipsync_job(
    job_id: str,
    video_path: Path,
    output_path: Path,
    request: LipSyncRequest,
):
    """Background task to process lip-sync."""
    try:
        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 10

        # Get or generate audio
        audio_path = None

        if request.audio_path:
            audio_path = Path(request.audio_path)
        elif request.audio_url:
            # Download audio from URL
            import urllib.request
            audio_path = OUTPUT_DIR / f"lipsync_audio_{job_id}.wav"
            urllib.request.urlretrieve(request.audio_url, audio_path)
        elif request.text and request.voice_id:
            # Generate audio from text
            from ..voice import VoiceClient
            client = VoiceClient()
            audio_path = OUTPUT_DIR / f"lipsync_audio_{job_id}.wav"
            client.generate(
                text=request.text,
                voice_id=request.voice_id,
                output_path=audio_path,
            )
        else:
            raise ValueError("Must provide audio_path, audio_url, or (text + voice_id)")

        jobs_store[job_id]["progress"] = 30

        # Determine time range
        info = get_video_info(video_path)
        start_time = request.start_time
        end_time = request.end_time or info.duration

        # Apply lip-sync using Sync Labs API
        from ..lipsync.engine import LipSyncEngine
        engine = LipSyncEngine(backend="synclabs")

        jobs_store[job_id]["progress"] = 50

        # Process the segment
        result_path = engine.process_segment(
            video_path=video_path,
            audio_path=audio_path,
            start_time=start_time,
            end_time=end_time,
            output_path=output_path,
        )

        jobs_store[job_id]["progress"] = 90

        # If we only lip-synced a segment, we need to splice it back
        if start_time > 0 or end_time < info.duration:
            from ..compose.composer import compose_personalized_video

            final_output = OUTPUT_DIR / f"lipsync_final_{job_id}.mp4"
            compose_personalized_video(
                original_video=video_path,
                processed_segments=[{
                    "video_path": result_path,
                    "start_time": start_time,
                    "end_time": end_time,
                }],
                output_path=final_output,
            )
            output_path = final_output

        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["output_url"] = f"/api/render/{job_id}/download"
        jobs_store[job_id]["output_path"] = str(output_path)

        logger.info(f"Lip-sync complete: {output_path}")

    except Exception as e:
        logger.exception("Lip-sync failed")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


# ============================================================================
# FULL PERSONALIZATION PIPELINE
# ============================================================================

class VoiceEdit(BaseModel):
    """Voice edit with automatic lip-sync."""
    original_text: str
    new_text: str
    start_time: float
    end_time: float
    voice_id: Optional[str] = None  # If not provided, uses cloned voice


class VisualReplacement(BaseModel):
    """Visual replacement with optional tracking."""
    x: float  # Percentage 0-100
    y: float
    width: float
    height: float
    start_time: float
    end_time: float
    replacement_type: str = "text"  # "text", "blur", "remove", "image"
    replacement_value: str = ""
    enable_tracking: bool = False  # Track object movement
    original_text: Optional[str] = None  # For logging


class FullPersonalizationRequest(BaseModel):
    """Complete personalization request."""
    video_id: str
    voice_edits: list[VoiceEdit] = []
    visual_replacements: list[VisualReplacement] = []
    voice_id: Optional[str] = None  # Default voice for all edits


@app.post("/api/personalize")
async def full_personalization(
    request: FullPersonalizationRequest,
    background_tasks: BackgroundTasks,
):
    """
    Full personalization pipeline:
    1. Voice edits with automatic lip-sync
    2. Visual replacements with optional motion tracking
    3. Video composition

    This is the main endpoint for complete video personalization.
    """
    if request.video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[request.video_id]
    video_path = Path(video["path"])

    # Create job
    job_id = str(uuid.uuid4())[:8]
    output_path = OUTPUT_DIR / f"personalized_{job_id}.mp4"

    jobs_store[job_id] = {
        "job_id": job_id,
        "video_id": request.video_id,
        "type": "full_personalization",
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background processing
    background_tasks.add_task(
        process_full_personalization,
        job_id,
        video_path,
        output_path,
        request,
        video.get("voice_id"),
    )

    return {"job_id": job_id, "status": "pending", "progress": 0}


async def process_full_personalization(
    job_id: str,
    video_path: Path,
    output_path: Path,
    request: FullPersonalizationRequest,
    default_voice_id: Optional[str],
):
    """Process complete personalization pipeline."""
    try:
        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 5

        info = get_video_info(video_path)
        current_video = video_path
        temp_files = []

        # Check if we have a separate camera file for high-quality lip-sync
        video_metadata = videos_store.get(request.video_id, {})
        has_camera = video_metadata.get("has_camera", False)
        camera_path = Path(video_metadata["camera_path"]) if video_metadata.get("camera_path") else None

        if has_camera and camera_path and camera_path.exists():
            logger.info(f"[DUAL RECORDING] Using separate camera file for lip-sync: {camera_path}")
            camera_info = get_video_info(camera_path)
            logger.info(f"[DUAL RECORDING] Camera: {camera_info.width}x{camera_info.height}, {camera_info.duration:.2f}s")
        else:
            logger.info("[SINGLE RECORDING] No separate camera file, will extract face from screen recording")
            camera_path = None

        # Step 1: Process voice edits with lip-sync
        if request.voice_edits:
            logger.info(f"Processing {len(request.voice_edits)} voice edits")
            jobs_store[job_id]["progress"] = 10

            from ..voice import VoiceClient
            from ..lipsync.engine import LipSyncEngine
            from ..compose.composer import compose_personalized_video

            voice_client = VoiceClient()

            # Use Sync Labs for lip-sync
            lipsync_engine = LipSyncEngine(backend="synclabs")
            logger.info("Using SyncLabs for lip-sync")

            processed_segments = []

            for i, edit in enumerate(request.voice_edits):
                voice_id = edit.voice_id or request.voice_id or default_voice_id
                if not voice_id:
                    logger.warning(f"No voice ID for edit {i}, skipping")
                    continue

                progress = 10 + int(40 * (i / len(request.voice_edits)))
                jobs_store[job_id]["progress"] = progress

                logger.info(f"Voice edit {i+1}: '{edit.original_text}' → '{edit.new_text}'")

                # Generate new audio at NATURAL speed - NO TIME STRETCHING
                # Research shows time-stretching degrades quality significantly
                # Instead, we adjust video timing to match natural audio
                original_segment_duration = edit.end_time - edit.start_time
                audio_path = OUTPUT_DIR / f"voice_{job_id}_{i}.wav"

                voice_client.generate(
                    text=edit.new_text,
                    voice_id=voice_id,
                    output_path=audio_path,
                )
                temp_files.append(audio_path)

                # Normalize audio loudness to match original video
                # Extract original audio segment to measure loudness
                from ..core.ffmpeg_utils import FFmpegProcessor
                original_audio_segment = OUTPUT_DIR / f"original_audio_{job_id}_{i}.wav"
                run_ffmpeg([
                    "-ss", str(edit.start_time),
                    "-i", str(current_video),
                    "-t", str(original_segment_duration),
                    "-vn",  # No video
                    "-acodec", "pcm_s16le",
                    "-ar", "44100",  # Match ElevenLabs source rate
                    str(original_audio_segment),
                ], "Extract original audio segment")
                temp_files.append(original_audio_segment)

                # Get original loudness and normalize generated audio to match
                original_loudness = FFmpegProcessor.get_audio_loudness(original_audio_segment)
                logger.info(f"Original audio loudness: {original_loudness} LUFS")

                # Clamp loudness to FFmpeg's valid range (-70 to -5 LUFS)
                # -inf means silent audio (short segment, no speech)
                import math
                if math.isinf(original_loudness) or original_loudness < -70:
                    logger.warning(f"Original loudness {original_loudness} out of range, using default -23 LUFS")
                    original_loudness = -23.0
                elif original_loudness > -5:
                    logger.warning(f"Original loudness {original_loudness} too high, clamping to -5 LUFS")
                    original_loudness = -5.0

                normalized_audio = OUTPUT_DIR / f"voice_{job_id}_{i}_normalized.wav"
                FFmpegProcessor.normalize_audio_loudness(
                    audio_path=audio_path,
                    output_path=normalized_audio,
                    target_lufs=original_loudness,
                )
                audio_path = normalized_audio
                temp_files.append(normalized_audio)

                # Get natural audio duration - this is sacred, we don't modify it
                audio_duration = get_audio_duration(audio_path)

                logger.info(f"Natural audio duration: {audio_duration:.2f}s, original segment: {original_segment_duration:.2f}s")

                # NO TIME STRETCHING - audio plays at natural speed
                # The final video may be slightly longer/shorter but will sound natural

                # ================================================================
                # DUAL RECORDING PATH: Use separate high-quality camera for lip-sync
                # ================================================================
                if camera_path:
                    logger.info(f"[DUAL RECORDING] Processing lip-sync on separate camera file")

                    # Extract camera segment for lip-sync (camera already at high resolution)
                    camera_segment_path = OUTPUT_DIR / f"camera_segment_{job_id}_{i}.mp4"

                    # Extract slightly more video if audio is longer
                    extract_end = edit.start_time + max(audio_duration, original_segment_duration) + 0.5
                    extract_end = min(extract_end, camera_info.duration)

                    FFmpegProcessor.extract_segment(
                        video_path=camera_path,
                        start_time=edit.start_time,
                        end_time=extract_end,
                        output_path=camera_segment_path,
                        reencode=True,
                    )
                    temp_files.append(camera_segment_path)

                    # Log camera segment info
                    cam_seg_info = get_video_info(camera_segment_path)
                    logger.info(f"[DUAL RECORDING] Camera segment: {cam_seg_info.width}x{cam_seg_info.height}, {cam_seg_info.duration:.2f}s")

                    # Apply lip-sync to camera segment (should be high quality now)
                    from ..lipsync.synclabs import SyncLabsClient
                    sync_client = SyncLabsClient()

                    lipsync_camera_output = OUTPUT_DIR / f"lipsync_camera_{job_id}_{i}.mp4"
                    sync_client.lipsync(
                        video_path=camera_segment_path,
                        audio_path=audio_path,
                        output_path=lipsync_camera_output,
                    )
                    temp_files.append(lipsync_camera_output)

                    # Log lip-sync result
                    input_hash = get_file_hash(camera_segment_path)
                    output_hash = get_file_hash(lipsync_camera_output)
                    logger.info(f"[DUAL RECORDING] Camera MD5 before: {input_hash}, after: {output_hash}")
                    logger.info(f"[DUAL RECORDING] Lip-sync applied: {input_hash != output_hash}")

                    lipsync_info = get_video_info(lipsync_camera_output)
                    actual_lipsync_duration = lipsync_info.duration
                    logger.info(f"[DUAL RECORDING] Lip-synced camera duration: {actual_lipsync_duration:.2f}s")

                    # Use Sync Labs output directly - avoid re-encoding to preserve quality
                    # Sync Labs already outputs properly encoded MP4
                    normalized_camera = lipsync_camera_output
                    # Note: No additional re-encoding needed - this preserves lip-sync quality

                    new_end_time = edit.start_time + actual_lipsync_duration

                    # Store as camera segment for later overlay
                    segment_entry = {
                        "video_path": normalized_camera,
                        "start_time": edit.start_time,
                        "end_time": new_end_time,
                        "original_end_time": edit.end_time,
                        "is_camera_segment": True,  # Flag for overlay processing
                    }
                    processed_segments.append(segment_entry)

                    logger.info(f"[DUAL RECORDING] Camera segment ready for overlay: {edit.start_time:.2f}s - {new_end_time:.2f}s")

                # ================================================================
                # EMBEDDED BUBBLE PATH: Camera bubble is IN the screen recording
                # Crop bubble, lip-sync, overlay back - much simpler, no sync issues
                # ================================================================
                elif video_metadata.get("has_embedded_bubble"):
                    logger.info(f"[EMBEDDED BUBBLE] Processing lip-sync on embedded camera bubble")

                    bubble_size = video_metadata.get("bubble_size", 400)
                    bubble_padding = video_metadata.get("bubble_padding", 30)
                    bubble_position = video_metadata.get("bubble_position", "bottom-left")

                    # Extract the video segment
                    segment_path = OUTPUT_DIR / f"segment_{job_id}_{i}.mp4"
                    extract_end = edit.start_time + max(audio_duration, original_segment_duration) + 0.5
                    extract_end = min(extract_end, info.duration)

                    FFmpegProcessor.extract_segment(
                        video_path=current_video,
                        start_time=edit.start_time,
                        end_time=extract_end,
                        output_path=segment_path,
                        reencode=True,
                    )
                    temp_files.append(segment_path)

                    # Crop the bubble region for lip-sync
                    cropped_bubble = OUTPUT_DIR / f"bubble_crop_{job_id}_{i}.mp4"
                    FFmpegProcessor.crop_bubble_region(
                        video_path=segment_path,
                        output_path=cropped_bubble,
                        bubble_size=bubble_size,
                        padding=bubble_padding,
                        position=bubble_position,
                    )
                    temp_files.append(cropped_bubble)

                    # Lip-sync the cropped bubble
                    from ..lipsync.synclabs import SyncLabsClient
                    sync_client = SyncLabsClient()

                    lipsync_bubble = OUTPUT_DIR / f"lipsync_bubble_{job_id}_{i}.mp4"
                    sync_client.lipsync(
                        video_path=cropped_bubble,
                        audio_path=audio_path,
                        output_path=lipsync_bubble,
                    )
                    temp_files.append(lipsync_bubble)

                    lipsync_info = get_video_info(lipsync_bubble)
                    actual_duration = lipsync_info.duration
                    logger.info(f"[EMBEDDED BUBBLE] Lip-synced bubble duration: {actual_duration:.2f}s")

                    # Overlay lip-synced bubble back onto original segment
                    final_segment = OUTPUT_DIR / f"final_segment_{job_id}_{i}.mp4"
                    FFmpegProcessor.overlay_lipsync_bubble(
                        original_video=segment_path,
                        lipsync_bubble=lipsync_bubble,
                        output_path=final_segment,
                        bubble_size=bubble_size,
                        padding=bubble_padding,
                        position=bubble_position,
                        new_audio=audio_path,  # Use ElevenLabs audio
                    )
                    temp_files.append(final_segment)

                    new_end_time = edit.start_time + actual_duration

                    segment_entry = {
                        "video_path": str(final_segment),
                        "start_time": edit.start_time,
                        "end_time": new_end_time,
                        "original_end_time": edit.end_time,
                    }
                    processed_segments.append(segment_entry)

                    logger.info(f"[EMBEDDED BUBBLE] Segment ready: {edit.start_time:.2f}s - {new_end_time:.2f}s")

                # ================================================================
                # SINGLE RECORDING PATH: Extract from screen, upscale if needed
                # ================================================================
                else:
                    # Extract video segment - extend/shrink to match audio duration
                    # This is the key: video adjusts to audio, not audio to video
                    video_segment_path = OUTPUT_DIR / f"video_segment_{job_id}_{i}.mp4"

                    # Extract slightly more video if audio is longer
                    extract_end = edit.start_time + max(audio_duration, original_segment_duration) + 0.5
                    extract_end = min(extract_end, info.duration)  # Don't exceed video length

                    FFmpegProcessor.extract_segment(
                        video_path=current_video,
                        start_time=edit.start_time,
                        end_time=extract_end,
                        output_path=video_segment_path,
                        reencode=True,
                    )
                    temp_files.append(video_segment_path)

                    # Apply lip-sync to the extracted segment
                    # Sync Labs will use the audio duration, creating natural lip movements
                    lipsync_output = OUTPUT_DIR / f"lipsync_{job_id}_{i}.mp4"

                    from ..lipsync.synclabs import SyncLabsClient
                    sync_client = SyncLabsClient()

                    # Log pre-lip-sync video info for diagnostics
                    segment_info = get_video_info(video_segment_path)
                    logger.info(f"[LIP-SYNC DEBUG] Input video: {video_segment_path}")
                    logger.info(f"[LIP-SYNC DEBUG] Input dimensions: {segment_info.width}x{segment_info.height}")
                    logger.info(f"[LIP-SYNC DEBUG] Input duration: {segment_info.duration:.2f}s")
                    logger.info(f"[LIP-SYNC DEBUG] Input size: {video_segment_path.stat().st_size} bytes")

                    # Check if video is too small for reliable lip-sync
                    min_dimension = min(segment_info.width, segment_info.height)
                    original_dims = None
                    lipsync_input = video_segment_path

                    if min_dimension < 512:
                        logger.warning(f"[LIP-SYNC DEBUG] Video too small ({min_dimension}px). Upscaling for better face detection!")
                        logger.warning(f"[LIP-SYNC DEBUG] Sync Labs works best with faces >= 256px in video >= 512px")

                        # Upscale the video segment for lip-sync processing
                        upscaled_path = OUTPUT_DIR / f"upscaled_{job_id}_{i}.mp4"
                        lipsync_input, original_dims = FFmpegProcessor.upscale_for_lipsync(
                            video_path=video_segment_path,
                            output_path=upscaled_path,
                            min_dimension=512,
                        )
                        temp_files.append(upscaled_path)

                        upscaled_info = get_video_info(lipsync_input)
                        logger.info(f"[LIP-SYNC DEBUG] Upscaled to: {upscaled_info.width}x{upscaled_info.height}")

                    sync_client.lipsync(
                        video_path=lipsync_input,
                        audio_path=audio_path,
                        output_path=lipsync_output,
                    )

                    # Log post-lip-sync info
                    logger.info(f"[LIP-SYNC DEBUG] Output video: {lipsync_output}")
                    logger.info(f"[LIP-SYNC DEBUG] Output size: {lipsync_output.stat().st_size} bytes")

                    # Calculate MD5 hashes to verify transformation
                    input_hash = get_file_hash(lipsync_input)
                    output_hash = get_file_hash(lipsync_output)
                    logger.info(f"[LIP-SYNC DEBUG] Input MD5: {input_hash}")
                    logger.info(f"[LIP-SYNC DEBUG] Output MD5: {output_hash}")
                    logger.info(f"[LIP-SYNC DEBUG] Files differ: {input_hash != output_hash}")

                    # If we upscaled, now downscale the lip-synced output back to original size
                    if original_dims is not None:
                        logger.info(f"[LIP-SYNC DEBUG] Downscaling back to original {original_dims[0]}x{original_dims[1]}")
                        downscaled_path = OUTPUT_DIR / f"lipsync_{job_id}_{i}_downscaled.mp4"
                        FFmpegProcessor.downscale_to_original(
                            video_path=lipsync_output,
                            output_path=downscaled_path,
                            original_dims=original_dims,
                        )
                        # Use the downscaled version going forward
                        lipsync_output = downscaled_path
                        temp_files.append(downscaled_path)
                        logger.info(f"[LIP-SYNC DEBUG] Downscaled output: {lipsync_output}")

                    temp_files.append(lipsync_output)

                    # Get the actual duration of the lip-synced output
                    lipsync_info = get_video_info(lipsync_output)
                    actual_lipsync_duration = lipsync_info.duration
                    logger.info(f"Lip-sync output duration: {actual_lipsync_duration:.2f}s (audio was {audio_duration:.2f}s)")

                    # Skip re-encoding here - final concatenation normalizes audio to 48kHz
                    # Sync Labs outputs 44100Hz but concatenate_segments handles this
                    # Avoiding extra re-encode preserves lip-sync quality
                    logger.info(f"[LIP-SYNC DEBUG] Using Sync Labs output directly (no re-encode)")
                    logger.info(f"[LIP-SYNC DEBUG] Final output: {lipsync_output}")

                    # The new segment duration is based on the actual lip-synced output
                    # This should match the audio duration since Sync Labs syncs to the audio
                    new_end_time = edit.start_time + actual_lipsync_duration

                    segment_entry = {
                        "video_path": lipsync_output,
                        "start_time": edit.start_time,
                        "end_time": new_end_time,  # Use audio-based timing
                        "original_end_time": edit.end_time,  # Track original for composition
                        "is_camera_segment": False,
                    }
                    processed_segments.append(segment_entry)

                    logger.info(f"[LIP-SYNC DEBUG] Segment entry: start={edit.start_time:.2f}s, end={new_end_time:.2f}s, original_end={edit.end_time:.2f}s")
                    logger.info(f"[LIP-SYNC DEBUG] Segment video path: {lipsync_output}")

            # Compose video with lip-synced segments
            if processed_segments:
                jobs_store[job_id]["progress"] = 50

                # Check if we're using dual recording (camera overlay) or single recording (segment composition)
                has_camera_segments = any(seg.get("is_camera_segment", False) for seg in processed_segments)

                if has_camera_segments and camera_path:
                    # ================================================================
                    # DUAL RECORDING: Clean approach
                    # 1. Splice lip-synced segments INTO original camera track
                    # 2. Splice screen recording to match new timeline
                    # 3. Overlay single composited camera onto composited screen
                    # ================================================================
                    logger.info(f"[DUAL RECORDING] Creating composited camera and screen tracks")

                    # Sort segments by start time
                    sorted_segments = sorted(processed_segments, key=lambda s: s["start_time"])

                    # Build list of camera segments to concatenate:
                    # [original_gap1, lipsync1, original_gap2, lipsync2, ..., original_gap_final]
                    camera_segments_to_concat = []
                    screen_segments_to_concat = []

                    prev_end = 0.0
                    time_offset = 0.0  # Track cumulative time shift from duration changes

                    for seg_idx, seg in enumerate(sorted_segments):
                        orig_start = seg["start_time"]
                        orig_end = seg["original_end_time"]
                        new_duration = seg["end_time"] - seg["start_time"]  # Duration of lip-synced segment
                        orig_duration = orig_end - orig_start

                        logger.info(f"[DUAL RECORDING] Segment {seg_idx}: orig {orig_start:.2f}s-{orig_end:.2f}s ({orig_duration:.2f}s) -> new duration {new_duration:.2f}s")

                        # Gap before this edit (from original camera/screen)
                        if orig_start > prev_end:
                            gap_duration = orig_start - prev_end
                            logger.info(f"[DUAL RECORDING] Adding gap: {prev_end:.2f}s - {orig_start:.2f}s ({gap_duration:.2f}s)")

                            # Extract camera gap
                            camera_gap_path = OUTPUT_DIR / f"camera_gap_{job_id}_{seg_idx}.mp4"
                            FFmpegProcessor.extract_segment(
                                video_path=camera_path,
                                start_time=prev_end,
                                end_time=orig_start,
                                output_path=camera_gap_path,
                                reencode=True,
                            )
                            camera_segments_to_concat.append(camera_gap_path)
                            temp_files.append(camera_gap_path)

                            # Extract screen gap
                            screen_gap_path = OUTPUT_DIR / f"screen_gap_{job_id}_{seg_idx}.mp4"
                            FFmpegProcessor.extract_segment(
                                video_path=current_video,
                                start_time=prev_end,
                                end_time=orig_start,
                                output_path=screen_gap_path,
                                reencode=True,
                            )
                            screen_segments_to_concat.append(screen_gap_path)
                            temp_files.append(screen_gap_path)

                        # Add the lip-synced camera segment
                        camera_segments_to_concat.append(Path(seg["video_path"]))
                        logger.info(f"[DUAL RECORDING] Adding lip-synced camera segment: {new_duration:.2f}s")

                        # For screen during this edit: adjust to match new duration
                        # Extract original screen segment and time-stretch if needed
                        screen_edit_path = OUTPUT_DIR / f"screen_edit_{job_id}_{seg_idx}.mp4"

                        if abs(new_duration - orig_duration) > 0.1:
                            # Duration changed - need to time-stretch screen
                            logger.info(f"[DUAL RECORDING] Time-stretching screen: {orig_duration:.2f}s -> {new_duration:.2f}s")

                            # Extract original screen segment
                            screen_orig_path = OUTPUT_DIR / f"screen_orig_{job_id}_{seg_idx}.mp4"
                            FFmpegProcessor.extract_segment(
                                video_path=current_video,
                                start_time=orig_start,
                                end_time=orig_end,
                                output_path=screen_orig_path,
                                reencode=True,
                            )
                            temp_files.append(screen_orig_path)

                            # Time-stretch to match new duration
                            speed_factor = orig_duration / new_duration
                            run_ffmpeg([
                                "-i", str(screen_orig_path),
                                "-filter_complex", f"[0:v]setpts={1/speed_factor}*PTS[v];[0:a]atempo={speed_factor}[a]",
                                "-map", "[v]",
                                "-map", "[a]",
                                "-c:v", "libx264",
                                "-preset", "fast",
                                "-crf", "18",
                                "-c:a", "aac",
                                "-ar", "48000",
                                str(screen_edit_path),
                            ], f"Time-stretch screen segment {seg_idx}")
                        else:
                            # Duration similar - just extract
                            FFmpegProcessor.extract_segment(
                                video_path=current_video,
                                start_time=orig_start,
                                end_time=orig_end,
                                output_path=screen_edit_path,
                                reencode=True,
                            )

                        screen_segments_to_concat.append(screen_edit_path)
                        temp_files.append(screen_edit_path)

                        prev_end = orig_end

                    # Final gap after last edit
                    if prev_end < info.duration:
                        logger.info(f"[DUAL RECORDING] Adding final gap: {prev_end:.2f}s - {info.duration:.2f}s")

                        camera_final_path = OUTPUT_DIR / f"camera_final_{job_id}.mp4"
                        FFmpegProcessor.extract_segment(
                            video_path=camera_path,
                            start_time=prev_end,
                            end_time=camera_info.duration,
                            output_path=camera_final_path,
                            reencode=True,
                        )
                        camera_segments_to_concat.append(camera_final_path)
                        temp_files.append(camera_final_path)

                        screen_final_path = OUTPUT_DIR / f"screen_final_{job_id}.mp4"
                        FFmpegProcessor.extract_segment(
                            video_path=current_video,
                            start_time=prev_end,
                            end_time=info.duration,
                            output_path=screen_final_path,
                            reencode=True,
                        )
                        screen_segments_to_concat.append(screen_final_path)
                        temp_files.append(screen_final_path)

                    # Concatenate camera segments into single composited camera
                    logger.info(f"[DUAL RECORDING] Concatenating {len(camera_segments_to_concat)} camera segments")
                    composited_camera_path = OUTPUT_DIR / f"composited_camera_{job_id}.mp4"
                    FFmpegProcessor.concatenate_segments(
                        segment_paths=camera_segments_to_concat,
                        output_path=composited_camera_path,
                        reencode=True,
                    )
                    temp_files.append(composited_camera_path)

                    # Concatenate screen segments into single composited screen
                    logger.info(f"[DUAL RECORDING] Concatenating {len(screen_segments_to_concat)} screen segments")
                    composited_screen_path = OUTPUT_DIR / f"composited_screen_{job_id}.mp4"
                    FFmpegProcessor.concatenate_segments(
                        segment_paths=screen_segments_to_concat,
                        output_path=composited_screen_path,
                        reencode=True,
                    )
                    temp_files.append(composited_screen_path)

                    # Overlay composited camera onto composited screen
                    logger.info(f"[DUAL RECORDING] Overlaying composited camera onto screen")
                    composed_path = OUTPUT_DIR / f"composed_{job_id}.mp4"
                    FFmpegProcessor.overlay_camera_bubble(
                        screen_video=composited_screen_path,
                        camera_video=composited_camera_path,
                        output_path=composed_path,
                        position="bottom-left",
                        bubble_size=180,
                        padding=30,
                        use_camera_audio=True,  # Use camera audio (has ElevenLabs TTS for lip-synced segments)
                    )

                    composed_info = get_video_info(composed_path)
                    logger.info(f"[DUAL RECORDING] Final composed video: {composed_info.duration:.2f}s")

                    current_video = composed_path
                    temp_files.append(composed_path)

                else:
                    # ================================================================
                    # SINGLE RECORDING: Compose segments back into video
                    # ================================================================
                    composed_path = OUTPUT_DIR / f"composed_{job_id}.mp4"

                    # Log composition inputs
                    logger.info(f"[COMPOSE DEBUG] Composing {len(processed_segments)} segments into final video")
                    logger.info(f"[COMPOSE DEBUG] Original video: {current_video}")
                    for idx, seg in enumerate(processed_segments):
                        logger.info(f"[COMPOSE DEBUG] Segment {idx}: {seg['video_path']} (exists: {Path(seg['video_path']).exists()})")
                        logger.info(f"[COMPOSE DEBUG]   Timing: {seg['start_time']:.2f}s - {seg['end_time']:.2f}s (original_end: {seg['original_end_time']:.2f}s)")

                    compose_personalized_video(
                        original_video=current_video,
                        processed_segments=processed_segments,
                        output_path=composed_path,
                    )

                    # Log composition output
                    composed_info = get_video_info(composed_path)
                    logger.info(f"[COMPOSE DEBUG] Composed video: {composed_path}")
                    logger.info(f"[COMPOSE DEBUG] Composed duration: {composed_info.duration:.2f}s")
                    logger.info(f"[COMPOSE DEBUG] Composed size: {composed_path.stat().st_size} bytes")

                    current_video = composed_path
                    temp_files.append(composed_path)

        # Step 1.5: If we have a camera file but NO voice edits, still overlay it
        # This ensures the camera bubble appears in the final video even without personalization
        if camera_path and not request.voice_edits:
            logger.info(f"[DUAL RECORDING] No voice edits, but overlaying camera bubble onto screen")
            jobs_store[job_id]["progress"] = 50

            overlay_output = OUTPUT_DIR / f"camera_overlay_{job_id}.mp4"

            # Overlay original camera for the entire video
            FFmpegProcessor.overlay_camera_bubble(
                screen_video=current_video,
                camera_video=camera_path,
                output_path=overlay_output,
                position="bottom-left",
                bubble_size=180,
                padding=30,
            )

            current_video = overlay_output
            temp_files.append(overlay_output)
            logger.info(f"[DUAL RECORDING] Camera bubble overlaid onto screen")

        # Step 2: Process visual replacements
        if request.visual_replacements:
            logger.info(f"Processing {len(request.visual_replacements)} visual replacements")
            jobs_store[job_id]["progress"] = 60

            from ..visual.replacer import VisualReplacer
            from ..visual.tracker import MotionTracker, BoundingBox
            from ..models import VisualSegment, SegmentType

            replacer = VisualReplacer()
            tracker = MotionTracker()

            segments = []
            assets = {}
            tracking_data = {}

            frame_width = info.width
            frame_height = info.height
            fps = info.fps

            for i, repl in enumerate(request.visual_replacements):
                segment_id = f"visual_{i}"

                # Convert percentage (0-100) to normalized (0-1) and clamp to valid range
                bbox = BoundingBox(
                    x=max(0, min(1, repl.x / 100)),
                    y=max(0, min(1, repl.y / 100)),
                    width=max(0.001, min(1, repl.width / 100)),  # Min width to avoid zero-size
                    height=max(0.001, min(1, repl.height / 100)),  # Min height to avoid zero-size
                )
                # Ensure box doesn't extend beyond frame bounds
                bbox = bbox.clamp()

                # Track if requested
                tracking_ref = None
                if repl.enable_tracking:
                    logger.info(f"Tracking visual element {i}")
                    start_frame = int(repl.start_time * fps)
                    end_frame = int(repl.end_time * fps)

                    tracked = tracker.track_region(
                        video_path=current_video,
                        initial_bbox=bbox,
                        start_frame=start_frame,
                        end_frame=end_frame,
                    )
                    tracking_data[segment_id] = tracked
                    tracking_ref = start_frame

                segment = VisualSegment(
                    id=segment_id,
                    segment_type=SegmentType.TEXT if repl.replacement_type == "text" else SegmentType.IMAGE,
                    start_time=repl.start_time,
                    end_time=repl.end_time,
                    x=bbox.x,
                    y=bbox.y,
                    width=bbox.width,
                    height=bbox.height,
                    placeholder_key=segment_id,
                    tracking_reference_frame=tracking_ref,
                )
                segments.append(segment)

                # Create asset
                pixel_width = int(bbox.width * frame_width)
                pixel_height = int(bbox.height * frame_height)

                if repl.replacement_type == "text":
                    asset = replacer.create_text_asset(
                        text=repl.replacement_value,
                        width=pixel_width,
                        height=pixel_height,
                        font_size=max(16, pixel_height - 8),
                        color=(255, 255, 255),
                        bg_color=(0, 0, 0),
                    )
                elif repl.replacement_type == "blur":
                    # Create blur mask (solid gray)
                    import numpy as np
                    blur_img = np.zeros((pixel_height, pixel_width, 4), dtype=np.uint8)
                    blur_img[:, :, :3] = 128  # Gray
                    blur_img[:, :, 3] = 180  # Semi-transparent
                    from ..visual.replacer import ReplacementAsset
                    asset = ReplacementAsset(image=blur_img, width=pixel_width, height=pixel_height)
                elif repl.replacement_type == "remove":
                    # Create transparent overlay (will be filled by inpainting or blur)
                    import numpy as np
                    remove_img = np.zeros((pixel_height, pixel_width, 4), dtype=np.uint8)
                    remove_img[:, :, :3] = 0
                    remove_img[:, :, 3] = 200  # Almost opaque black
                    from ..visual.replacer import ReplacementAsset
                    asset = ReplacementAsset(image=remove_img, width=pixel_width, height=pixel_height)
                else:
                    # Image replacement - load from URL or path
                    asset = replacer.load_image_asset(
                        image_path=repl.replacement_value,
                        target_width=pixel_width,
                        target_height=pixel_height,
                    )

                assets[segment_id] = asset

            jobs_store[job_id]["progress"] = 80

            # Process video with visual replacements
            visual_output = OUTPUT_DIR / f"visual_{job_id}.mp4"
            replacer.process_video(
                video_path=current_video,
                segments=segments,
                assets=assets,
                output_path=visual_output,
            )
            current_video = visual_output
            temp_files.append(visual_output)

        # Step 3: Final output
        jobs_store[job_id]["progress"] = 95

        # Copy to final output path
        import shutil
        shutil.copy(current_video, output_path)

        # Cleanup temp files (optional - keep for debugging)
        # for f in temp_files:
        #     if f.exists() and f != output_path:
        #         f.unlink()

        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["output_url"] = f"/api/render/{job_id}/download"
        jobs_store[job_id]["output_path"] = str(output_path)

        logger.info(f"Full personalization complete: {output_path}")

    except Exception as e:
        logger.exception("Full personalization failed")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


# ============================================================================
# PREMIUM FEATURES: Enhancement Processing
# ============================================================================

class ClickEvent(BaseModel):
    """A click event for auto-zoom."""
    t: float  # timestamp in seconds
    x: float  # normalized 0-1
    y: float
    button: str = "left"


class BlurRegion(BaseModel):
    """A region to blur for privacy."""
    id: str
    x: float  # normalized 0-1
    y: float
    w: float
    h: float
    start: float  # start time in seconds
    end: float    # end time in seconds


class CursorPoint(BaseModel):
    """A cursor position point."""
    t: float
    x: float
    y: float


class EnhanceRequest(BaseModel):
    """Request to apply premium enhancement effects."""
    clicks: list[ClickEvent] = []
    blur_regions: list[BlurRegion] = []
    cursor_path: list[CursorPoint] = []
    settings: dict = {}  # {autoZoom: bool, cursorEffects: bool, blurEnabled: bool}


class FillerWord(BaseModel):
    """A detected filler word."""
    id: str
    type: str  # "filler" or "silence"
    text: str
    start: float
    end: float


class DetectFillersResponse(BaseModel):
    """Response from filler detection."""
    fillers: list[FillerWord]
    total_duration: float
    filler_duration: float


class RemoveFillersRequest(BaseModel):
    """Request to remove specific filler segments."""
    filler_ids: list[str]  # IDs of fillers to remove


@app.post("/api/videos/{video_id}/enhance")
async def enhance_video(
    video_id: str,
    request: EnhanceRequest,
    background_tasks: BackgroundTasks,
):
    """
    Apply premium enhancement effects to video.

    Effects include:
    - Auto-zoom on clicks
    - Privacy blur on regions
    - Cursor smoothing and effects (coming soon)
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    # Create job
    job_id = str(uuid.uuid4())[:8]
    output_path = OUTPUT_DIR / f"enhanced_{job_id}.mp4"

    jobs_store[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "type": "enhance",
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background processing
    background_tasks.add_task(
        process_enhance_job,
        job_id,
        video_path,
        output_path,
        request,
    )

    return {"job_id": job_id, "status": "pending", "progress": 0}


async def process_enhance_job(
    job_id: str,
    video_path: Path,
    output_path: Path,
    request: EnhanceRequest,
):
    """Background task to apply enhancement effects."""
    try:
        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 10

        current_video = video_path
        temp_files = []
        settings = request.settings or {}

        # Step 1: Apply zoom effects on clicks
        if request.clicks and settings.get("autoZoom", True):
            logger.info(f"Applying zoom effects for {len(request.clicks)} clicks")
            jobs_store[job_id]["progress"] = 30

            zoom_output = output_path.parent / f"zoom_{job_id}.mp4"
            FFmpegProcessor.apply_zoom_effects(
                video_path=current_video,
                output_path=zoom_output,
                clicks=[c.model_dump() for c in request.clicks],
                zoom_factor=1.5,
                zoom_duration=2.0,
            )
            temp_files.append(current_video) if current_video != video_path else None
            current_video = zoom_output

        # Step 2: Apply blur regions
        if request.blur_regions and settings.get("blurEnabled", True):
            logger.info(f"Applying blur to {len(request.blur_regions)} regions")
            jobs_store[job_id]["progress"] = 60

            blur_output = output_path.parent / f"blur_{job_id}.mp4"
            FFmpegProcessor.apply_blur_regions(
                video_path=current_video,
                output_path=blur_output,
                regions=[{
                    'x': r.x,
                    'y': r.y,
                    'w': r.w,
                    'h': r.h,
                    'start': r.start,
                    'end': r.end,
                } for r in request.blur_regions],
                blur_strength=20,
            )
            temp_files.append(current_video) if current_video != video_path else None
            current_video = blur_output

        # Step 3: Copy final result
        jobs_store[job_id]["progress"] = 90

        if current_video != output_path:
            shutil.copy(current_video, output_path)

        # Cleanup temp files
        for f in temp_files:
            if f and Path(f).exists() and f != video_path:
                Path(f).unlink(missing_ok=True)

        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["output_url"] = f"/api/render/{job_id}/download"
        jobs_store[job_id]["output_path"] = str(output_path)

        logger.info(f"Enhancement complete: {output_path}")

    except Exception as e:
        logger.exception("Enhancement failed")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


@app.get("/api/videos/{video_id}/detect-fillers", response_model=DetectFillersResponse)
async def detect_fillers(video_id: str):
    """
    Detect filler words and long silences in video.

    Returns list of detected fillers that user can preview before removal.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]

    # Check if transcript exists
    if not video.get("transcript"):
        raise HTTPException(
            status_code=400,
            detail="Video must be transcribed first. Call POST /api/videos/{video_id}/transcribe"
        )

    try:
        from ..audio.filler_detection import FillerDetector

        detector = FillerDetector()
        transcript = video["transcript"]
        duration = video["duration"]

        fillers = detector.detect_fillers(transcript, duration)

        total_filler_duration = sum(f["end"] - f["start"] for f in fillers)

        # Store fillers with video for later removal
        video["detected_fillers"] = fillers
        videos_store[video_id] = video

        return DetectFillersResponse(
            fillers=[FillerWord(**f) for f in fillers],
            total_duration=duration,
            filler_duration=total_filler_duration,
        )

    except ImportError:
        raise HTTPException(status_code=500, detail="Filler detection module not available")
    except Exception as e:
        logger.exception("Filler detection failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/videos/{video_id}/remove-fillers")
async def remove_fillers(
    video_id: str,
    request: RemoveFillersRequest,
    background_tasks: BackgroundTasks,
):
    """
    Remove selected filler words from video.

    User must call detect-fillers first to get filler IDs.
    """
    if video_id not in videos_store:
        raise HTTPException(status_code=404, detail="Video not found")

    video = videos_store[video_id]
    video_path = Path(video["path"])

    if not video.get("detected_fillers"):
        raise HTTPException(
            status_code=400,
            detail="Must detect fillers first. Call GET /api/videos/{video_id}/detect-fillers"
        )

    # Get fillers to remove
    all_fillers = {f["id"]: f for f in video["detected_fillers"]}
    fillers_to_remove = [all_fillers[fid] for fid in request.filler_ids if fid in all_fillers]

    if not fillers_to_remove:
        raise HTTPException(status_code=400, detail="No valid filler IDs provided")

    # Create job
    job_id = str(uuid.uuid4())[:8]
    output_path = OUTPUT_DIR / f"nofiller_{job_id}.mp4"

    jobs_store[job_id] = {
        "job_id": job_id,
        "video_id": video_id,
        "type": "remove_fillers",
        "status": "pending",
        "progress": 0,
        "output_url": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # Start background processing
    background_tasks.add_task(
        process_remove_fillers_job,
        job_id,
        video_path,
        output_path,
        fillers_to_remove,
    )

    return {"job_id": job_id, "status": "pending", "progress": 0, "removing_count": len(fillers_to_remove)}


async def process_remove_fillers_job(
    job_id: str,
    video_path: Path,
    output_path: Path,
    fillers: list[dict],
):
    """Background task to remove filler segments."""
    try:
        jobs_store[job_id]["status"] = "processing"
        jobs_store[job_id]["progress"] = 10

        # Convert fillers to cuts format
        cuts = [{"start": f["start"], "end": f["end"]} for f in fillers]

        logger.info(f"Removing {len(cuts)} filler segments")
        jobs_store[job_id]["progress"] = 30

        FFmpegProcessor.remove_segments(
            video_path=video_path,
            output_path=output_path,
            cuts=cuts,
            crossfade_ms=100,
        )

        jobs_store[job_id]["progress"] = 100
        jobs_store[job_id]["status"] = "completed"
        jobs_store[job_id]["output_url"] = f"/api/render/{job_id}/download"
        jobs_store[job_id]["output_path"] = str(output_path)

        logger.info(f"Filler removal complete: {output_path}")

    except Exception as e:
        logger.exception("Filler removal failed")
        jobs_store[job_id]["status"] = "failed"
        jobs_store[job_id]["error"] = str(e)


# ============================================================================
# Quick test endpoints
# ============================================================================

@app.get("/api/test/services")
async def test_services():
    """Test that all services are working."""
    results = {}

    # Test Chirp 3
    try:
        from ..transcription import GoogleSpeechClient
        client = GoogleSpeechClient()
        results["chirp3"] = "connected"
    except Exception as e:
        results["chirp3"] = f"error: {e}"

    # Test Vision
    try:
        from ..vision import GoogleVisionClient
        client = GoogleVisionClient()
        results["vision"] = "connected"
    except Exception as e:
        results["vision"] = f"error: {e}"

    # Test ElevenLabs
    try:
        from ..voice import VoiceClient
        client = VoiceClient()
        voices = client.list_voices()
        results["elevenlabs"] = f"connected ({len(voices)} voices)"
    except Exception as e:
        results["elevenlabs"] = f"error: {e}"

    # Test Sync Labs
    try:
        from ..lipsync import SyncLabsClient
        client = SyncLabsClient()
        results["synclabs"] = "connected"
    except Exception as e:
        results["synclabs"] = f"error: {e}"

    return results


def create_app():
    """Factory function to create the app (for testing/alternative startup)."""
    return app


# Run with: uvicorn src.api.server:app --reload --port 8000
