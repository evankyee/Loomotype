# Working Architecture

## The Core Problem

When personalizing "Hello {name}" → "Hello Alice":
- Original audio: 2.5 seconds
- Generated audio: 2.3 seconds (different!)
- If we don't handle this, video goes out of sync

## Solution: Time-Stretch Audio

We time-stretch the generated audio to EXACTLY match the original segment duration.
This keeps the video perfectly in sync.

## Production Stack

| Component | Service | Why |
|-----------|---------|-----|
| Voice Generation | ElevenLabs API | Best quality cloning |
| Audio Time-Stretch | FFmpeg rubberband | Preserves pitch while changing duration |
| Lip-Sync | **Sync Labs API** | Production-ready, handles edge cases, 4K support |
| Visual Overlays | FFmpeg overlay filter | Fast, no quality loss |
| Video Composition | FFmpeg concat + filter_complex | Proper splicing |
| Storage | Google Cloud Storage | All processing in cloud |
| Database | Firestore | Job tracking |
| API | Cloud Run | Serverless |

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PERSONALIZATION FLOW                           │
└─────────────────────────────────────────────────────────────────────────┘

1. INPUT
   ├── Base Video (GCS)
   ├── Template (segments to personalize)
   └── Data (client_name="Alice", company="Acme")

2. VOICE GENERATION (per segment)
   ├── Get original segment duration from video
   ├── Generate audio: "Hello Alice" via ElevenLabs
   ├── Time-stretch audio to match original duration
   └── Output: audio file exactly matching original timing

3. LIP-SYNC (per segment)
   ├── Extract video segment (ffmpeg -ss -t)
   ├── Upload video + audio to Sync Labs
   ├── Poll until complete
   ├── Download lip-synced segment
   └── Output: video segment with synced lips

4. VISUAL OVERLAYS (single pass)
   ├── Generate overlay images (PIL for text, download for logos)
   ├── Build FFmpeg filter_complex with overlay + enable
   └── Apply all overlays in one pass

5. COMPOSITION
   ├── Build segment list: [original | lip-synced | original | ...]
   ├── Use FFmpeg concat demuxer
   ├── Apply visual overlays
   └── Output: final personalized video

6. DELIVERY
   ├── Upload to GCS
   ├── Generate signed URL
   └── Webhook callback
```

## Critical Implementation Details

### Audio Time-Stretching
```bash
# Stretch audio to exactly 2.5 seconds using rubberband
ffmpeg -i input.mp3 -filter:a "rubberband=tempo=0.92" -t 2.5 output.mp3

# Or calculate tempo ratio
original_duration = 2.5
new_duration = 2.3
tempo = new_duration / original_duration  # 0.92
# tempo < 1 = slow down, tempo > 1 = speed up
```

### Segment Extraction (Frame-Accurate)
```bash
# Extract segment from 10.5s to 15.2s
ffmpeg -ss 10.5 -i input.mp4 -t 4.7 -c copy segment.mp4

# For frame-accurate cuts, may need to re-encode
ffmpeg -ss 10.5 -i input.mp4 -t 4.7 -c:v libx264 -c:a aac segment.mp4
```

### Visual Overlay (FFmpeg)
```bash
# Overlay logo at position (100,50) from 5s to 30s
ffmpeg -i video.mp4 -i logo.png \
  -filter_complex "[0][1]overlay=100:50:enable='between(t,5,30)'" \
  output.mp4

# Multiple overlays
ffmpeg -i video.mp4 -i logo.png -i text.png \
  -filter_complex "
    [0][1]overlay=100:50:enable='between(t,5,30)'[v1];
    [v1][2]overlay=200:100:enable='between(t,0,10)'"
  output.mp4
```

### Concat with Different Codecs
```bash
# If segments have different codecs, re-encode to common format first
# Then use concat demuxer
echo "file 'segment1.mp4'" > list.txt
echo "file 'segment2.mp4'" >> list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4
```

## Error Handling

1. **Sync Labs timeout** - Retry up to 3 times, then fail job
2. **Audio generation fails** - Fail job with clear error
3. **Video segment extraction fails** - Likely timestamp issue, log and fail
4. **Overlay generation fails** - Skip overlay, continue with video

## Cost Per Video (2-minute video, 3 personalized segments)

| Component | Cost |
|-----------|------|
| ElevenLabs (30 sec total) | ~$0.50 |
| Sync Labs (30 sec total) | ~$1.50 |
| Cloud Run processing | ~$0.05 |
| Storage | ~$0.01 |
| **Total** | **~$2.06** |
