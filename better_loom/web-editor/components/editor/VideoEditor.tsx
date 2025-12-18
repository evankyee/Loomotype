'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Timeline } from './Timeline';
import { TranscriptEditor } from './TranscriptEditor';
import { VisualSelector } from './VisualSelector';
import { DetectionPanel } from './DetectionPanel';
import { useEditorStore } from '@/lib/store';
import { api } from '@/lib/api';

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
  const [selectionMode, setSelectionMode] = useState<'none' | 'visual' | 'transcript'>('none');
  const [visualSelections, setVisualSelections] = useState<VisualSelection[]>([]);

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

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  }, []);

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
      const safeStart = isFinite(trimStart) ? trimStart : 0;
      const safeEnd = isFinite(trimEnd) ? trimEnd : videoRef.current.duration || 0;

      const clampedTime = Math.max(safeStart, Math.min(safeEnd, safeTime));
      if (isFinite(clampedTime)) {
        videoRef.current.currentTime = clampedTime;
        setCurrentTime(videoRef.current.currentTime);
      }
    }
  }, [trimStart, trimEnd]);

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

  // Get cloned voice ID from store
  const { selectedVoiceId: clonedVoiceId } = useEditorStore();

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

    // Check if there's anything to do
    if (voiceEdits.length === 0 && visualReplacements.length === 0) {
      setRenderError('No changes configured. Edit transcript or select visual regions.');
      return;
    }

    setIsRendering(true);
    setRenderProgress(0);
    setRenderError(null);

    try {
      let job: { job_id: string; status: string; progress: number };

      // Use full personalization if there are voice edits, otherwise just visual render
      if (voiceEdits.length > 0) {
        // Full pipeline with voice + lip-sync + visual
        job = await api.personalize(
          videoId,
          voiceEdits,
          visualReplacements,
          clonedVoiceId || undefined
        );
      } else {
        // Visual-only render (faster)
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
      }

      setRenderJobId(job.job_id);

      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const status = await api.getRenderStatus(job.job_id);
          setRenderProgress(status.progress);

          if (status.status === 'completed') {
            clearInterval(pollInterval);
            setIsRendering(false);
            // Switch to preview mode - show rendered video in editor
            const preview = api.getPreviewUrl(job.job_id);
            setPreviewUrl(preview);
            setPreviewError(null);  // Clear any previous preview error
            setIsPreviewMode(true);
            // Pause and reset to start for preview
            if (videoRef.current) {
              videoRef.current.pause();
              videoRef.current.currentTime = 0;
            }
          } else if (status.status === 'failed') {
            clearInterval(pollInterval);
            setIsRendering(false);
            setRenderError(status.error || 'Render failed');
          }
        } catch (err) {
          clearInterval(pollInterval);
          setIsRendering(false);
          setRenderError(err instanceof Error ? err.message : 'Polling failed');
        }
      }, 2000);
    } catch (err) {
      setIsRendering(false);
      setRenderError(err instanceof Error ? err.message : 'Render failed');
    }
  }, [videoId, visualSelections, editedWords, storeTranscript, clonedVoiceId]);

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

  // Handle discarding preview and returning to original
  const handleDiscardPreview = useCallback(() => {
    setIsPreviewMode(false);
    setPreviewUrl(null);
    setRenderJobId(null);
    setPreviewError(null);
    // Video will automatically switch back to original URL
  }, []);

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
              <div className="absolute top-4 left-4 right-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="bg-green-600 text-white px-3 py-1 rounded-full text-sm font-medium">
                    Preview Mode
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDiscardPreview}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleSavePreview}
                      disabled={isSaving || !!previewError}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {isSaving ? 'Saving...' : 'Save Video'}
                    </button>
                  </div>
                </div>
                {/* Preview error message */}
                {previewError && (
                  <div className="bg-red-600/90 text-white px-3 py-2 rounded-lg text-sm">
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
              className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 hover:opacity-100 transition-opacity"
            >
              <div className="w-20 h-20 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <svg className="w-10 h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
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
      </div>

      {/* Controls bar */}
      <div className="bg-card border-t border-border p-3">
        <div className="flex items-center gap-4">
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            className="p-2 rounded-lg hover:bg-card-hover transition-colors"
          >
            {isPlaying ? (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* Time display */}
          <div className="text-sm font-mono text-muted">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2">
            <button onClick={toggleMute} className="p-1 hover:text-primary transition-colors">
              {isMuted || volume === 0 ? (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
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
              className="w-20 accent-primary"
            />
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Selection mode toggle */}
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
            <button
              onClick={() => setSelectionMode('none')}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selectionMode === 'none' ? 'bg-primary text-white' : 'text-muted hover:text-foreground'
              }`}
            >
              View
            </button>
            <button
              onClick={() => setSelectionMode('visual')}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selectionMode === 'visual' ? 'bg-primary text-white' : 'text-muted hover:text-foreground'
              }`}
            >
              Select
            </button>
          </div>

          {/* Render button */}
          <button
            onClick={handleRenderVideo}
            disabled={isRendering || (visualSelections.filter(s => s.replacementValue || s.replacementType === 'blur' || s.replacementType === 'remove').length === 0 && Object.keys(editedWords).length === 0)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              isRendering
                ? 'bg-yellow-500/20 text-yellow-400 cursor-wait'
                : (visualSelections.filter(s => s.replacementValue || s.replacementType === 'blur' || s.replacementType === 'remove').length === 0 && Object.keys(editedWords).length === 0)
                ? 'bg-secondary text-muted cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isRendering ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Rendering {renderProgress}%
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
                </svg>
                Render Video
              </>
            )}
          </button>

          {/* Render error indicator */}
          {renderError && (
            <span className="text-red-400 text-xs max-w-48 truncate" title={renderError}>
              {renderError}
            </span>
          )}

          {/* Playback speed */}
          <select
            value={playbackRate}
            onChange={(e) => changePlaybackRate(parseFloat(e.target.value))}
            className="bg-secondary text-sm rounded-lg px-2 py-1.5 outline-none"
          >
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1">1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>

          {/* Fullscreen */}
          <button className="p-2 rounded-lg hover:bg-card-hover transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
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
