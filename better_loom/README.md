# Personalized Video Engine

A high-fidelity video personalization system that creates ultra-realistic personalized demo videos by **editing** (not synthesizing) original recordings.

## Key Principle

**90% original pixels** - We modify only what needs to change:
- Voice segments are re-generated and lip-synced
- Visual elements (names, logos) are replaced
- Everything else remains from the original recording

This approach yields videos indistinguishable from single-take recordings.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     PERSONALIZATION PIPELINE                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│  │   Voice     │    │  Lip-Sync   │    │   Visual    │              │
│  │  Generate   │───▶│   Engine    │    │  Replace    │              │
│  │ (ElevenLabs)│    │  (Wav2Lip)  │    │  (OpenCV)   │              │
│  └─────────────┘    └─────────────┘    └─────────────┘              │
│         │                  │                  │                      │
│         └──────────────────┴──────────────────┘                      │
│                            │                                         │
│                    ┌───────▼───────┐                                │
│                    │   Composer    │                                │
│                    │   (FFmpeg)    │                                │
│                    └───────────────┘                                │
│                            │                                         │
│                    ┌───────▼───────┐                                │
│                    │  Cloud Storage │                               │
│                    │   (GCS)       │                                │
│                    └───────────────┘                                │
└──────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Voice Cloning | ElevenLabs | Best quality, natural prosody |
| Lip-Sync | Wav2Lip (local) | Free, good quality |
| Visual Tracking | OpenCV CSRT | Accurate, handles movement |
| Video Processing | FFmpeg | Industry standard, fast |
| Database | Firestore | Serverless, scales to zero |
| Storage | Cloud Storage | Integrated with GCP |
| API | FastAPI + Cloud Run | Serverless, auto-scaling |

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Set Up GCP

```bash
# Run setup script
chmod +x scripts/setup-gcp.sh
./scripts/setup-gcp.sh your-project-id us-central1
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 4. Clone Your Presenter's Voice

```bash
# Provide audio samples (30+ minutes recommended for best quality)
python -m src.cli clone-voice \
    --name "presenter" \
    presenter_audio_1.mp3 presenter_audio_2.mp3
```

### 5. Create a Template

```bash
# Create template from JSON definition
python -m src.cli create-template --config templates/example_template.json
```

### 6. Run Personalization

```bash
# Personalize a video
python -m src.cli personalize \
    --template demo_v1 \
    --data templates/example_personalization.json
```

## API Usage

### Start the Server

```bash
python -m src.cli serve --port 8080
```

### Create a Job

```bash
curl -X POST http://localhost:8080/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "demo_v1",
    "client_name": "Alice",
    "company_name": "Acme Corp",
    "webhook_url": "https://your-webhook.com/callback"
  }'
```

### Check Status

```bash
curl http://localhost:8080/jobs/{job_id}
```

## Deploy to Cloud Run

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_SERVICE_NAME=personalization-engine
```

## Project Structure

```
better_loom/
├── src/
│   ├── voice/           # ElevenLabs voice cloning
│   │   ├── client.py    # Voice client implementation
│   │   └── clone.py     # Cloning utilities
│   ├── lipsync/         # Lip synchronization
│   │   ├── engine.py    # Main lip-sync interface
│   │   ├── wav2lip.py   # Local Wav2Lip implementation
│   │   └── synclabs.py  # Sync Labs API (optional)
│   ├── visual/          # Visual replacement
│   │   ├── tracker.py   # Motion tracking (OpenCV)
│   │   └── replacer.py  # Text/image replacement
│   ├── compose/         # Video composition
│   │   └── composer.py  # FFmpeg-based assembly
│   ├── pipeline/        # Orchestration
│   │   ├── orchestrator.py  # Main pipeline
│   │   ├── jobs.py      # Firestore job management
│   │   └── storage.py   # GCS file handling
│   ├── api/             # REST API
│   │   └── server.py    # FastAPI endpoints
│   ├── models.py        # Data models
│   ├── config.py        # Configuration
│   └── cli.py           # Command line interface
├── templates/           # Template definitions
├── scripts/             # Setup scripts
├── Dockerfile           # Container image
├── cloudbuild.yaml      # Cloud Build config
└── requirements.txt     # Python dependencies
```

## Template Definition

Templates define what can be personalized in a video:

```json
{
  "id": "demo_v1",
  "name": "Product Demo",
  "base_video_path": "gs://bucket/videos/base.mp4",
  "voice_id": "elevenlabs-voice-id",
  "voice_segments": [
    {
      "id": "greeting",
      "start_time": 2.0,
      "end_time": 5.5,
      "template_text": "Hello {client_name}!"
    }
  ],
  "visual_segments": [
    {
      "id": "logo",
      "segment_type": "image",
      "start_time": 0.0,
      "end_time": 30.0,
      "x": 0.85, "y": 0.05,
      "width": 0.1, "height": 0.08,
      "placeholder_key": "logo"
    }
  ]
}
```

## Cost Breakdown

| Component | Cost | Notes |
|-----------|------|-------|
| ElevenLabs | ~$0.30/min audio | Pro plan recommended |
| Cloud Run | ~$0.00002/vCPU-sec | Scales to zero |
| Cloud Storage | ~$0.02/GB/month | Pay for what you store |
| Firestore | Free tier covers most | First 50K reads/day free |

**Estimated cost per video:** $0.50-2.00 depending on length and segments.

## Quality Tips

1. **Base Video Quality**
   - Record at 1080p or higher
   - Good lighting on presenter's face
   - Clear audio without background noise

2. **Voice Cloning**
   - Provide 30+ minutes of varied speech
   - Include different tones and emotions
   - Clean audio without music/effects

3. **Lip-Sync**
   - Wav2Lip works best at 720p
   - Face should be clearly visible
   - Avoid extreme head angles

4. **Visual Replacement**
   - Use consistent placeholder styling
   - Define clear bounding boxes
   - Test tracking on moving elements

## Extending

### Add a New Lip-Sync Backend

```python
# src/lipsync/custom.py
from .engine import BaseLipSync

class CustomLipSync(BaseLipSync):
    def sync(self, video_path, audio_path, output_path, **kwargs):
        # Your implementation
        pass
```

### Add a New Visual Effect

```python
# Extend VisualReplacer in src/visual/replacer.py
def apply_custom_effect(self, frame, params):
    # Your effect implementation
    return modified_frame
```

## License

MIT
