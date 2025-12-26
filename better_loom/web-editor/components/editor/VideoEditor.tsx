'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Timeline } from './Timeline';
import { TranscriptEditor } from './TranscriptEditor';
import { VisualSelector } from './VisualSelector';
import { DetectionPanel } from './DetectionPanel';
import { BubblePanel } from './BubblePanel';
import { useEditorStore } from '@/lib/store';
import { api, BubbleSettings, BubbleVisibility } from '@/lib/api';

/**
 * Adaptive polling for job status - starts fast, slows down over time.
 * Reduces perceived latency by detecting completion quickly while
 * avoiding excessive polling on long-running jobs.
 */
function createAdaptivePoller(
  pollFn: () => Promise<{ done: boolean; error?: string }>,
  onComplete: () => void,
  onError: (error: string) => void,
  initialInterval: number = 250,  // Start fast
  maxInterval: number = 2000,     // Cap at 2s
  backoffFactor: number = 1.5     // Increase by 50% each poll
) {
  let interval = initialInterval;
  let timeoutId: NodeJS.Timeout | null = null;
  let cancelled = false;

  const poll = async () => {
    if (cancelled) return;

    try {
      const result = await pollFn();
      if (cancelled) return;

      if (result.done) {
        if (result.error) {
          onError(result.error);
        } else {
          onComplete();
        }
        return;
      }

      // Schedule next poll with increased interval (adaptive backoff)
      interval = Math.min(interval * backoffFactor, maxInterval);
      timeoutId = setTimeout(poll, interval);
    } catch (err) {
      if (!cancelled) {
        onError(err instanceof Error ? err.message : 'Polling failed');
      }
    }
  };

  // Start polling immediately
  poll();

  // Return cancel function
  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
}

interface VideoEditorProps {
  videoUrl: string;
}

export interface TranscriptWord {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  isEdited?: boolean;
  editedText?: string;
}

export interface VisualSelection {
  id: string;
  /** X position as percentage (0-100) of video frame width */
  x: number;
  /** Y position as percentage (0-100) of video frame height */
  y: number;
  /** Width as percentage (0-100) of video frame width */
  width: number;
  /** Height as percentage (0-100) of video frame height */
  height: number;
  startTime: number;
  endTime: number;
  type: 'manual' | 'detected';
  label?: string;
  replacementType?: 'text' | 'blur' | 'remove';
  replacementValue?: string;
  enableTracking?: boolean;
}

export function VideoEditor({ videoUrl }: VideoEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Trim state
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  // Selection modes
  const [selectionMode, setSelectionMode] = useState<'none' | 'visual' | 'transcript' | 'bubble'>('none');
  const [visualSelections, setVisualSelections] = useState<VisualSelection[]>([]);

  // Bubble composite state
  const [bubbleJobId, setBubbleJobId] = useState<string | null>(null);
  const [bubbleOutputUrl, setBubbleOutputUrl] = useState<string | null>(null);
  const [bubbleError, setBubbleError] = useState<string | null>(null);

  // Bubble settings - LIFTED from BubblePanel for accumulative editing
  // These settings are collected during render and passed to api.personalize()
  const [bubblePosition, setBubblePosition] = useState<BubbleSettings['position']>('bottom-left');
  const [bubbleSize, setBubbleSize] = useState(0.25);
  const [bubbleShape, setBubbleShape] = useState<BubbleSettings['shape']>('circle');
  const [bubbleVisibility, setBubbleVisibility] = useState<BubbleVisibility[]>([]);
  const [hasCamera, setHasCamera] = useState(false);
  const [bubbleSettingsLoaded, setBubbleSettingsLoaded] = useState(false);

  // Highlight state for bidirectional sync between panel and video overlay
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // Render state
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderJobId, setRenderJobId] = useState<string | null>(null);

  // Preview state - shows rendered video in editor before saving
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Use real transcript from store (Google Chirp 3)
  const {
    transcript: storeTranscript,
    isTranscribing,
    transcribeError,
    transcribeVideo,
    videoId,
    duration: apiDuration,
    segments,
  } = useEditorStore();

  // Local state for edited words (edits overlay on top of store transcript)
  const [editedWords, setEditedWords] = useState<Record<string, string>>({});

  // Convert store transcript to local format for display, applying edits
  const transcript: TranscriptWord[] = storeTranscript?.segments.flatMap(seg =>
    seg.words.map(w => ({
      id: w.id,
      text: w.text,
      startTime: w.startTime,
      endTime: w.endTime,
      isEdited: !!editedWords[w.id],
      editedText: editedWords[w.id],
    }))
  ) || [];

  // Video event handlers
  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      const videoDuration = videoRef.current.duration;
      // Only set if duration is valid and finite
      if (videoDuration && isFinite(videoDuration) && videoDuration > 0) {
        setDuration(videoDuration);
        setTrimEnd(videoDuration);
      } else if (apiDuration && isFinite(apiDuration) && apiDuration > 0) {
        // Use API duration as fallback (WebM files often have Infinity duration)
        setDuration(apiDuration);
        setTrimEnd(apiDuration);
      }
    }
  }, [apiDuration]);

  // Also try to get duration when video data is loaded (backup)
  const handleLoadedData = useCallback(() => {
    if (videoRef.current && duration === 0) {
      const videoDuration = videoRef.current.duration;
      if (videoDuration && isFinite(videoDuration) && videoDuration > 0) {
        setDuration(videoDuration);
        setTrimEnd(videoDuration);
      } else if (apiDuration && isFinite(apiDuration) && apiDuration > 0) {
        setDuration(apiDuration);
        setTrimEnd(apiDuration);
      }
    }
  }, [duration, apiDuration]);

  // Handle duration change (for some video formats)
  const handleDurationChange = useCallback(() => {
    if (videoRef.current && duration === 0) {
      const videoDuration = videoRef.current.duration;
      if (videoDuration && isFinite(videoDuration) && videoDuration > 0) {
        setDuration(videoDuration);
        setTrimEnd(videoDuration);
      } else if (apiDuration && isFinite(apiDuration) && apiDuration > 0) {
        setDuration(apiDuration);
        setTrimEnd(apiDuration);
      }
    }
  }, [duration, apiDuration]);

  // Use API duration as fallback if video element doesn't provide one
  useEffect(() => {
    if (duration === 0 && apiDuration && isFinite(apiDuration) && apiDuration > 0) {
      setDuration(apiDuration);
      setTrimEnd(apiDuration);
    }
  }, [apiDuration, duration]);

  // Reset bubble settings loaded flag when video changes
  useEffect(() => {
    setBubbleSettingsLoaded(false);
  }, [videoId]);

  // Load bubble settings from API when video changes (for accumulative editing)
  useEffect(() => {
    if (!videoId || bubbleSettingsLoaded) return;

    async function loadBubbleSettings() {
      try {
        const info = await api.getVideoInfo(videoId!);
        console.log('[BubblePanel] Video info:', info.has_camera, info.camera_path);
        setHasCamera(info.has_camera);
        if (info.bubble_settings) {
          setBubblePosition(info.bubble_settings.position);
          setBubbleSize(info.bubble_settings.size);
          setBubbleShape(info.bubble_settings.shape);
          setBubbleVisibility(info.bubble_settings.visibility || []);
        }
        setBubbleSettingsLoaded(true);
      } catch (err) {
        console.error('Failed to load bubble settings:', err);
        setBubbleSettingsLoaded(true); // Mark as loaded even on error
      }
    }

    loadBubbleSettings();
  }, [videoId, bubbleSettingsLoaded]);

  // Check if a time falls within a valid (non-trimmed, non-deleted) segment
  const getValidTimeRanges = useCallback(() => {
    if (!segments || segments.length === 0) return [];

    return segments
      .filter(s => !s.isDeleted)
      .map(s => ({
        start: s.originalStart + s.trimStart,
        end: s.originalEnd - s.trimEnd,
      }))
      .filter(r => r.end > r.start) // Filter out empty ranges
      .sort((a, b) => a.start - b.start);
  }, [segments]);

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;

    const time = videoRef.current.currentTime;
    setCurrentTime(time);

    // Real-time segment skipping: if current time is in a trimmed/deleted area, skip to next valid position
    if (segments && segments.length > 0 && isPlaying) {
      const validRanges = getValidTimeRanges();

      if (validRanges.length === 0) return;

      // Check if current time is within any valid range
      const inValidRange = validRanges.some(r => time >= r.start && time <= r.end);

      if (!inValidRange) {
        // Find the next valid range
        const nextRange = validRanges.find(r => r.start > time);

        if (nextRange) {
          // Skip to start of next valid range
          videoRef.current.currentTime = nextRange.start;
        } else {
          // No more valid ranges, pause at end
          videoRef.current.pause();
          setIsPlaying(false);
        }
      }
    }
  }, [segments, isPlaying, getValidTimeRanges]);

  // Handle video load errors (especially for preview)
  const handleVideoError = useCallback(() => {
    if (isPreviewMode) {
      setPreviewError('Failed to load preview video. The render may have failed.');
    }
  }, [isPreviewMode]);

  // Clear preview error when preview URL changes (new preview loaded)
  const handlePreviewLoaded = useCallback(() => {
    setPreviewError(null);
  }, []);

  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  }, [isPlaying]);

  const seek = useCallback((time: number) => {
    if (videoRef.current) {
      // Guard against non-finite values
      const safeTime = isFinite(time) ? time : 0;

      // If we have segments, find the nearest valid position
      if (segments && segments.length > 0) {
        const validRanges = getValidTimeRanges();

        if (validRanges.length > 0) {
          // Check if time is in a valid range
          const inRange = validRanges.find(r => safeTime >= r.start && safeTime <= r.end);

          if (inRange) {
            // Time is valid, use it
            videoRef.current.currentTime = safeTime;
          } else {
            // Find nearest valid range
            const nextRange = validRanges.find(r => r.start > safeTime);
            const prevRange = [...validRanges].reverse().find(r => r.end < safeTime);

            if (nextRange && (!prevRange || (nextRange.start - safeTime) < (safeTime - prevRange.end))) {
              videoRef.current.currentTime = nextRange.start;
            } else if (prevRange) {
              videoRef.current.currentTime = prevRange.end;
            } else if (validRanges.length > 0) {
              videoRef.current.currentTime = validRanges[0].start;
            }
          }
          setCurrentTime(videoRef.current.currentTime);
          return;
        }
      }

      // Fallback to simple trim logic
      const safeStart = isFinite(trimStart) ? trimStart : 0;
      const safeEnd = isFinite(trimEnd) ? trimEnd : videoRef.current.duration || 0;

      const clampedTime = Math.max(safeStart, Math.min(safeEnd, safeTime));
      if (isFinite(clampedTime)) {
        videoRef.current.currentTime = clampedTime;
        setCurrentTime(videoRef.current.currentTime);
      }
    }
  }, [trimStart, trimEnd, segments, getValidTimeRanges]);

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  const changeVolume = useCallback((newVolume: number) => {
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    }
  }, []);

  const changePlaybackRate = useCallback((rate: number) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
      setPlaybackRate(rate);
    }
  }, []);

  // Generate real transcript using Google Chirp 3 via API
  const generateTranscript = useCallback(async () => {
    if (!videoId) {
      console.error('No video ID - video must be uploaded to server first');
      return;
    }
    await transcribeVideo();
  }, [videoId, transcribeVideo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case ' ':
          // Only toggle play in view mode, not during visual selection
          if (selectionMode === 'none') {
            e.preventDefault();
            togglePlay();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(currentTime + 5);
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seek, toggleMute, currentTime, selectionMode]);

  // Enforce trim boundaries during playback
  useEffect(() => {
    if (videoRef.current && isPlaying && currentTime >= trimEnd) {
      videoRef.current.pause();
      setIsPlaying(false);
      seek(trimStart);
    }
  }, [currentTime, trimEnd, trimStart, isPlaying, seek]);

  const handleAddVisualSelection = useCallback((selection: Omit<VisualSelection, 'id'>) => {
    const newSelection: VisualSelection = {
      ...selection,
      id: `selection-${Date.now()}`,
    };
    setVisualSelections(prev => [...prev, newSelection]);
  }, []);

  const handleUpdateVisualSelection = useCallback((id: string, updates: Partial<VisualSelection>) => {
    setVisualSelections(prev =>
      prev.map(s => s.id === id ? { ...s, ...updates } : s)
    );
  }, []);

  const handleDeleteVisualSelection = useCallback((id: string) => {
    setVisualSelections(prev => prev.filter(s => s.id !== id));
  }, []);

  const handleTranscriptWordClick = useCallback((word: TranscriptWord) => {
    seek(word.startTime);
  }, [seek]);

  const handleTranscriptEdit = useCallback((wordId: string, newText: string) => {
    setEditedWords(prev => ({
      ...prev,
      [wordId]: newText,
    }));
  }, []);

  // Get cloned voice ID and deletions from store (segments already imported above)
  const { selectedVoiceId: clonedVoiceId, deletions, getOrderedSegments } = useEditorStore();

  // Render video with all configured replacements (visual + voice)
  const handleRenderVideo = useCallback(async () => {
    if (!videoId) {
      setRenderError('Video must be uploaded first');
      return;
    }

    // Collect voice edits from transcript changes
    const voiceEdits: Array<{
      original_text: string;
      new_text: string;
      start_time: number;
      end_time: number;
    }> = [];

    // Find edited transcript words and group them into segments
    if (storeTranscript?.segments) {
      for (const segment of storeTranscript.segments) {
        for (const word of segment.words) {
          const editedText = editedWords[word.id];
          if (editedText && editedText !== word.text) {
            voiceEdits.push({
              original_text: word.text,
              new_text: editedText,
              start_time: word.startTime,
              end_time: word.endTime,
            });
          }
        }
      }
    }

    // Collect visual replacements from selections
    const visualReplacements = visualSelections
      .filter(s => s.replacementValue || s.replacementType === 'blur' || s.replacementType === 'remove')
      .map(s => ({
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        start_time: s.startTime,
        end_time: s.endTime,
        replacement_type: s.replacementType || 'text' as const,
        replacement_value: s.replacementValue || '',
        enable_tracking: s.enableTracking || false,
        original_text: s.label,
      }));

    // Collect bubble settings if camera is available and settings differ from defaults
    // Check if bubble settings have been modified from defaults
    const hasBubbleChanges = hasCamera && (
      bubblePosition !== 'bottom-left' ||
      Math.abs(bubbleSize - 0.25) > 0.01 ||
      bubbleShape !== 'circle' ||
      bubbleVisibility.length > 0
    );

    const currentBubbleSettings: BubbleSettings | undefined = hasCamera ? {
      position: bubblePosition,
      size: bubbleSize,
      shape: bubbleShape,
      visibility: bubbleVisibility,
    } : undefined;

    // Convert deletions to API format
    const deletionEdits = deletions.map(d => ({
      start_time: d.startTime,
      end_time: d.endTime,
    }));

    // Convert segments to API format (only non-deleted, sorted by outputStart)
    const activeSegs = segments.filter(s => !s.isDeleted).sort((a, b) => (a.outputStart || 0) - (b.outputStart || 0));
    const hasSegmentEdits = segments.length > 1 || segments.some(s => s.isDeleted || s.trimStart > 0 || s.trimEnd > 0);
    const segmentEdits = hasSegmentEdits ? activeSegs.map(s => ({
      id: s.id,
      original_start: s.originalStart,
      original_end: s.originalEnd,
      trim_start: s.trimStart,
      trim_end: s.trimEnd,
      output_start: s.outputStart || 0,
      order: s.order,
    })) : undefined;

    // Debug logging
    console.log('[Render] ===== SEGMENT DEBUG =====');
    console.log('[Render] segments.length:', segments.length);
    console.log('[Render] Full segments state:', JSON.stringify(segments, null, 2));
    console.log('[Render] Active segments (non-deleted):', activeSegs.length);
    console.log('[Render] hasSegmentEdits:', hasSegmentEdits);
    console.log('[Render] segmentEdits being sent:', segmentEdits);
    if (segments.length > 0) {
      segments.forEach((s, i) => {
        console.log(`[Render] Segment ${i}: original=${s.originalStart.toFixed(2)}-${s.originalEnd.toFixed(2)}, trim=${s.trimStart.toFixed(2)}/${s.trimEnd.toFixed(2)}, deleted=${s.isDeleted}`);
      });
    }
    console.log('[Render] ===========================');

    // Check if there's anything to do
    if (voiceEdits.length === 0 && visualReplacements.length === 0 && !hasBubbleChanges && deletionEdits.length === 0 && !hasSegmentEdits) {
      setRenderError('No changes configured. Edit transcript, delete words, split/trim clips, select visual regions, or adjust camera bubble.');
      return;
    }

    setIsRendering(true);
    setRenderProgress(0);
    setRenderError(null);

    try {
      let job: { job_id: string; status: string; progress: number };

      // Use full personalization for voice edits, bubble settings, deletions, segments, or comprehensive render
      // Visual-only render is a fast path when only visual changes are needed
      const needsFullPipeline = voiceEdits.length > 0 || hasBubbleChanges || deletionEdits.length > 0 || hasSegmentEdits;

      if (needsFullPipeline) {
        // Full pipeline with voice + lip-sync + visual + bubble compositing + deletions + segments
        job = await api.personalize(
          videoId,
          voiceEdits,
          visualReplacements,
          clonedVoiceId || undefined,
          currentBubbleSettings,
          deletionEdits.length > 0 ? deletionEdits : undefined,
          segmentEdits
        );
      } else if (visualReplacements.length > 0) {
        // Visual-only render (faster path when no voice/bubble changes)
        const textReplacements = visualReplacements.map(r => ({
          original_text: r.original_text || '',
          new_text: r.replacement_value,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          start_time: r.start_time,
          end_time: r.end_time,
        }));
        job = await api.renderVideoWithReplacements(videoId, textReplacements);
      } else {
        // Should not reach here due to validation above
        throw new Error('No changes to render');
      }

      setRenderJobId(job.job_id);

      // Adaptive polling - starts at 250ms, backs off to 2s max
      // Detects completion ~1.5s faster than fixed 2s polling
      const jobId = job.job_id;
      createAdaptivePoller(
        async () => {
          const status = await api.getRenderStatus(jobId);
          setRenderProgress(status.progress);
          if (status.status === 'completed') {
            return { done: true };
          } else if (status.status === 'failed') {
            return { done: true, error: status.error || 'Render failed' };
          }
          return { done: false };
        },
        () => {
          // On complete
          setIsRendering(false);
          const preview = api.getPreviewUrl(jobId);
          setPreviewUrl(preview);
          setPreviewError(null);
          setIsPreviewMode(true);
          if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.currentTime = 0;
          }
        },
        (error) => {
          // On error
          setIsRendering(false);
          setRenderError(error);
        },
        250,  // Start fast
        2000  // Cap at 2s for long jobs
      );
    } catch (err) {
      setIsRendering(false);
      setRenderError(err instanceof Error ? err.message : 'Render failed');
    }
  }, [videoId, visualSelections, editedWords, storeTranscript, clonedVoiceId, hasCamera, bubblePosition, bubbleSize, bubbleShape, bubbleVisibility, segments, deletions]);

  // Handle saving preview to permanent storage
  const handleSavePreview = useCallback(async () => {
    if (!renderJobId) return;

    setIsSaving(true);
    try {
      const result = await api.savePreview(renderJobId);
      // Download the saved file
      const downloadUrl = `${window.location.origin.replace(':3000', ':8000')}${result.download_url}`;
      window.open(downloadUrl, '_blank');
      // Exit preview mode
      setIsPreviewMode(false);
      setPreviewUrl(null);
      setRenderJobId(null);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : 'Failed to save video');
    } finally {
      setIsSaving(false);
    }
  }, [renderJobId]);

  // Handle exiting preview mode to continue editing
  // IMPORTANT: This does NOT discard edits - all pending edits are preserved
  // User can make more changes and preview again with accumulated edits
  const handleExitPreview = useCallback(() => {
    setIsPreviewMode(false);
    setPreviewUrl(null);
    setRenderJobId(null);
    setPreviewError(null);
    // Video switches back to original for editing
    // All edits (editedWords, visualSelections, etc.) remain intact
  }, []);

  // Fast bubble-only update during preview mode
  // Uses cached processed tracks - skips TTS + lip-sync for instant updates
  const handleFastBubbleUpdate = useCallback(async () => {
    if (!renderJobId || !hasCamera) return;

    setIsRendering(true);
    setRenderProgress(0);
    setRenderError(null);

    try {
      const settings: BubbleSettings = {
        position: bubblePosition,
        size: bubbleSize,
        shape: bubbleShape,
        visibility: bubbleVisibility,
      };

      // Call fast endpoint that skips TTS/lip-sync
      const job = await api.updateBubbleFast(renderJobId, settings);

      // Adaptive polling for fast bubble updates - starts at 150ms
      // These are quick operations so we use faster polling than full renders
      const jobId = job.job_id;
      createAdaptivePoller(
        async () => {
          const status = await api.getRenderStatus(jobId);
          setRenderProgress(status.progress);
          if (status.status === 'completed') {
            return { done: true };
          } else if (status.status === 'failed') {
            return { done: true, error: status.error || 'Bubble update failed' };
          }
          return { done: false };
        },
        () => {
          // On complete
          setIsRendering(false);
          const preview = api.getPreviewUrl(jobId);
          setPreviewUrl(preview);
          setRenderJobId(jobId); // Update to new job for future updates
        },
        (error) => {
          // On error
          setIsRendering(false);
          setRenderError(error);
        },
        150,  // Start very fast for quick operations
        1000  // Cap at 1s since bubble updates are fast
      );
    } catch (err) {
      setIsRendering(false);
      // Fall back to full render if fast update fails (e.g., no cached tracks)
      console.warn('Fast bubble update failed, falling back to full render:', err);
      handleRenderVideo();
    }
  }, [renderJobId, hasCamera, bubblePosition, bubbleSize, bubbleShape, bubbleVisibility, handleRenderVideo]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Main content area with video and detection panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video container with visual selector overlay */}
        <div className="flex-1 flex items-center justify-center bg-black relative">
          {/* inline-block ensures this wrapper shrinks to exactly fit the video element,
              so the VisualSelector overlay (using inset-0) perfectly covers only the video */}
          <div className="relative inline-block">
            <video
              ref={videoRef}
              src={isPreviewMode && previewUrl ? previewUrl : videoUrl}
              className="max-w-full max-h-[calc(100vh-350px)] block"
              onLoadedMetadata={handleLoadedMetadata}
              onLoadedData={(e) => { handleLoadedData(); if (isPreviewMode) handlePreviewLoaded(); }}
              onDurationChange={handleDurationChange}
              onTimeUpdate={handleTimeUpdate}
              onEnded={() => setIsPlaying(false)}
              onError={handleVideoError}
              onClick={selectionMode === 'none' ? togglePlay : undefined}
            />

            {/* Preview mode indicator and controls */}
            {isPreviewMode && (
              <div className="absolute top-3 left-3 right-3 flex flex-col gap-2 animate-fade-in">
                <div className="flex items-center justify-between">
                  <div className="glass px-2.5 py-1.5 rounded-lg flex items-center gap-2 border border-white/5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse-subtle" />
                    <span className="text-xs font-medium text-foreground-secondary">Preview</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleExitPreview}
                      className="glass px-3 py-1.5 rounded-lg text-xs font-medium text-foreground-secondary hover:text-foreground border border-white/5 hover:border-white/10 transition-all duration-100 active:scale-[0.98]"
                      title="Exit preview and continue editing"
                    >
                      Back to Edit
                    </button>
                    <button
                      onClick={handleSavePreview}
                      disabled={isSaving || !!previewError}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-100 active:scale-[0.98]"
                    >
                      {isSaving ? 'Saving...' : 'Export'}
                    </button>
                  </div>
                </div>
                {previewError && (
                  <div className="glass bg-danger/10 text-danger px-3 py-1.5 rounded-lg text-xs border border-danger/20">
                    {previewError}
                  </div>
                )}
              </div>
            )}

            {/* Only show visual selector when NOT in preview mode */}
            {selectionMode === 'visual' && !isPreviewMode && (
              <VisualSelector
                videoRef={videoRef}
                currentTime={currentTime}
                selections={visualSelections}
                onAddSelection={handleAddVisualSelection}
                onUpdateSelection={handleUpdateVisualSelection}
                onDeleteSelection={handleDeleteVisualSelection}
                highlightedId={highlightedId}
                onHighlight={setHighlightedId}
                showDetectionBoxes={true}
              />
            )}
          </div>

          {/* Play/Pause overlay - hidden in selection mode */}
          {!isPlaying && selectionMode === 'none' && (
            <button
              onClick={togglePlay}
              className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 hover:opacity-100 transition-opacity duration-200"
            >
              <div className="w-16 h-16 rounded-full glass border border-white/10 flex items-center justify-center hover:scale-105 transition-transform duration-150">
                <svg className="w-7 h-7 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </button>
          )}
        </div>

        {/* Detection Panel - shown when in visual selection mode (hidden during preview) */}
        {selectionMode === 'visual' && !isPreviewMode && (
          <DetectionPanel
            currentTime={currentTime}
            selections={visualSelections}
            onAddSelection={handleAddVisualSelection}
            onUpdateSelection={handleUpdateVisualSelection}
            onDeleteSelection={handleDeleteVisualSelection}
            highlightedId={highlightedId}
            onHighlight={setHighlightedId}
          />
        )}

        {/* Bubble Panel - shown when in bubble mode (ALSO during preview for adjustments) */}
        {selectionMode === 'bubble' && videoId && (
          <div className="w-72 bg-surface border-l border-border-subtle overflow-y-auto">
            <BubblePanel
              videoId={videoId}
              duration={duration}
              currentTime={currentTime}
              hasCamera={hasCamera}
              position={bubblePosition}
              size={bubbleSize}
              shape={bubbleShape}
              visibility={bubbleVisibility}
              onPositionChange={setBubblePosition}
              onSizeChange={setBubbleSize}
              onShapeChange={setBubbleShape}
              onVisibilityChange={setBubbleVisibility}
            />
            {isPreviewMode && (
              <div className="px-4 py-3 border-t border-border-subtle">
                <p className="text-xs text-foreground-tertiary mb-2">
                  Adjust bubble settings, then click to apply. Fast update uses cached lip-sync.
                </p>
                <button
                  onClick={handleFastBubbleUpdate}
                  disabled={isRendering}
                  className="w-full px-3 py-2 rounded-md text-xs font-medium bg-success text-white hover:bg-success-hover disabled:opacity-50 transition-all"
                >
                  {isRendering ? 'Updating...' : 'Fast Update (no re-render)'}
                </button>
              </div>
            )}
            {bubbleError && (
              <div className="px-4 pb-4">
                <div className="text-xs text-danger bg-danger/10 rounded-md p-2">
                  {bubbleError}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div className="bg-surface border-t border-border-subtle px-3 py-2">
        <div className="flex items-center gap-2.5">
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            className="p-1.5 rounded-lg text-foreground-secondary hover:text-foreground hover:bg-white/5 transition-all duration-100 active:scale-95"
          >
            {isPlaying ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86a1 1 0 00-1.5.86z" />
              </svg>
            )}
          </button>

          {/* Time display */}
          <div className="text-xs font-mono text-foreground-muted tabular-nums">
            <span className="text-foreground-secondary">{formatTime(currentTime)}</span>
            <span className="mx-1 opacity-40">/</span>
            <span>{formatTime(duration)}</span>
          </div>

          {/* Volume */}
          <div className="flex items-center gap-1.5 ml-1">
            <button
              onClick={toggleMute}
              className="p-1 text-foreground-muted hover:text-foreground-secondary transition-colors duration-100"
            >
              {isMuted || volume === 0 ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(e) => changeVolume(parseFloat(e.target.value))}
              className="w-14 h-0.5 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground-secondary hover:[&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:transition-colors"
            />
          </div>

          <div className="flex-1" />

          {/* Mode toggle */}
          <div className="flex items-center bg-white/5 rounded-lg p-0.5">
            <button
              onClick={() => setSelectionMode('none')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-100 ${
                selectionMode === 'none'
                  ? 'bg-white/10 text-foreground'
                  : 'text-foreground-muted hover:text-foreground-secondary'
              }`}
            >
              View
            </button>
            <button
              onClick={() => setSelectionMode('visual')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-100 ${
                selectionMode === 'visual'
                  ? 'bg-white/10 text-foreground'
                  : 'text-foreground-muted hover:text-foreground-secondary'
              }`}
            >
              Select
            </button>
            <button
              onClick={() => setSelectionMode('bubble')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-100 ${
                selectionMode === 'bubble'
                  ? 'bg-white/10 text-foreground'
                  : 'text-foreground-muted hover:text-foreground-secondary'
              }`}
            >
              Camera
            </button>
          </div>

          {/* Pending edits */}
          {(() => {
            const voiceCount = Object.keys(editedWords).length;
            const visualCount = visualSelections.filter(s => s.replacementValue || s.replacementType === 'blur' || s.replacementType === 'remove').length;
            const hasBubble = hasCamera && (bubblePosition !== 'bottom-left' || Math.abs(bubbleSize - 0.25) > 0.01 || bubbleShape !== 'circle' || bubbleVisibility.length > 0);
            const totalEdits = voiceCount + visualCount + (hasBubble ? 1 : 0);

            if (totalEdits > 0) {
              return (
                <div className="flex items-center gap-1.5 text-2xs text-foreground-muted bg-white/5 rounded-md px-2 py-1">
                  {voiceCount > 0 && <span className="text-primary">{voiceCount} voice</span>}
                  {visualCount > 0 && <span className="text-warning">{visualCount} visual</span>}
                  {hasBubble && <span className="text-success">camera</span>}
                </div>
              );
            }
            return null;
          })()}

          {/* Render button */}
          {(() => {
            const voiceCount = Object.keys(editedWords).length;
            const visualCount = visualSelections.filter(s => s.replacementValue || s.replacementType === 'blur' || s.replacementType === 'remove').length;
            const hasBubble = hasCamera && (bubblePosition !== 'bottom-left' || Math.abs(bubbleSize - 0.25) > 0.01 || bubbleShape !== 'circle' || bubbleVisibility.length > 0);
            const hasAnyEdits = voiceCount > 0 || visualCount > 0 || hasBubble;
            const isDisabled = isRendering || !hasAnyEdits;

            return (
              <button
                onClick={handleRenderVideo}
                disabled={isDisabled}
                className={`h-7 px-3 rounded-lg text-xs font-medium transition-all duration-100 flex items-center gap-1.5 active:scale-[0.98] ${
                  isRendering
                    ? 'bg-primary/20 text-primary'
                    : !hasAnyEdits
                    ? 'bg-white/5 text-foreground-muted cursor-not-allowed'
                    : 'bg-primary text-white hover:bg-primary-hover'
                }`}
              >
                {isRendering ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span className="tabular-nums">{renderProgress}%</span>
                  </>
                ) : (
                  'Preview'
                )}
              </button>
            );
          })()}

          {renderError && (
            <span className="text-danger text-2xs max-w-32 truncate" title={renderError}>
              {renderError}
            </span>
          )}

          {/* Speed */}
          <select
            value={playbackRate}
            onChange={(e) => changePlaybackRate(parseFloat(e.target.value))}
            className="bg-white/5 text-2xs text-foreground-secondary rounded-md px-1.5 py-1 border-none outline-none cursor-pointer appearance-none hover:bg-white/10 transition-colors duration-100"
          >
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1">1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>

          {/* Fullscreen */}
          <button className="p-1.5 rounded-md text-foreground-muted hover:text-foreground-secondary hover:bg-white/5 transition-all duration-100">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Timeline */}
      <Timeline
        duration={duration}
        currentTime={currentTime}
        trimStart={trimStart}
        trimEnd={trimEnd}
        onSeek={seek}
        onTrimStartChange={setTrimStart}
        onTrimEndChange={setTrimEnd}
        visualSelections={visualSelections}
      />

      {/* Transcript Editor */}
      <TranscriptEditor
        transcript={transcript}
        currentTime={currentTime}
        isTranscribing={isTranscribing}
        transcribeError={transcribeError}
        videoId={videoId}
        onGenerateTranscript={generateTranscript}
        onWordClick={handleTranscriptWordClick}
        onEditWord={handleTranscriptEdit}
      />

    </div>
  );
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) {
    return '0:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
