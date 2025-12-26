'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/store';
import type { VisualSelection } from './VideoEditor';

interface TimelineProps {
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  onSeek: (time: number) => void;
  onTrimStartChange: (time: number) => void;
  onTrimEndChange: (time: number) => void;
  visualSelections: VisualSelection[];
}

export function Timeline({
  duration,
  currentTime,
  onSeek,
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<'playhead' | 'trim-left' | 'trim-right' | 'clip' | null>(null);
  const [draggedSegmentId, setDraggedSegmentId] = useState<string | null>(null);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartOutputStart, setDragStartOutputStart] = useState(0);

  const {
    segments,
    initializeSegments,
    splitAtTime,
    deleteSegment,
    restoreSegment,
    trimSegment,
    moveSegment,
  } = useEditorStore();

  // Initialize segments when duration is set
  useEffect(() => {
    if (duration > 0 && segments.length === 0) {
      initializeSegments(duration);
    }
  }, [duration, segments.length, initializeSegments]);

  // Get non-deleted segments sorted by outputStart
  const activeSegments = useMemo(() => {
    return segments.filter(s => !s.isDeleted).sort((a, b) => (a.outputStart || 0) - (b.outputStart || 0));
  }, [segments]);

  // Calculate timeline duration (from 0 to end of last clip)
  const timelineDuration = useMemo(() => {
    if (activeSegments.length === 0) return duration;
    let maxEnd = 0;
    for (const seg of activeSegments) {
      const clipDuration = seg.originalEnd - seg.originalStart - seg.trimStart - seg.trimEnd;
      const clipEnd = (seg.outputStart || 0) + clipDuration;
      if (clipEnd > maxEnd) maxEnd = clipEnd;
    }
    return Math.max(maxEnd, duration);
  }, [activeSegments, duration]);

  // Convert pixel X to timeline time
  const getTimeFromX = useCallback((clientX: number): number => {
    if (!timelineRef.current || timelineDuration === 0) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const percent = (clientX - rect.left) / rect.width;
    return Math.max(0, percent * timelineDuration);
  }, [timelineDuration]);

  const handleMouseDown = useCallback((e: React.MouseEvent, type: 'playhead' | 'trim-left' | 'trim-right' | 'clip', segmentId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(type);
    setDragStartX(e.clientX);
    if (segmentId) {
      setDraggedSegmentId(segmentId);
      const seg = segments.find(s => s.id === segmentId);
      if (seg) setDragStartOutputStart(seg.outputStart || 0);
    }
  }, [segments]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !timelineRef.current) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const pixelsPerSecond = rect.width / timelineDuration;

    if (isDragging === 'playhead') {
      const time = getTimeFromX(e.clientX);
      onSeek(Math.min(time, timelineDuration));
    } else if (isDragging === 'clip' && draggedSegmentId) {
      // Move clip: change its outputStart based on drag delta
      const deltaX = e.clientX - dragStartX;
      const deltaTime = deltaX / pixelsPerSecond;
      const newOutputStart = Math.max(0, dragStartOutputStart + deltaTime);
      moveSegment(draggedSegmentId, newOutputStart);
    } else if ((isDragging === 'trim-left' || isDragging === 'trim-right') && draggedSegmentId) {
      const segment = segments.find(s => s.id === draggedSegmentId);
      if (!segment) return;

      const mouseTime = getTimeFromX(e.clientX);
      const clipOutputStart = segment.outputStart || 0;
      const clipDuration = segment.originalEnd - segment.originalStart - segment.trimStart - segment.trimEnd;
      const clipOutputEnd = clipOutputStart + clipDuration;

      if (isDragging === 'trim-left') {
        // Trim from left: difference between mouse and clip start
        const delta = mouseTime - clipOutputStart;
        const maxTrim = segment.originalEnd - segment.originalStart - segment.trimEnd - 0.5;
        const newTrimStart = Math.max(0, Math.min(maxTrim, segment.trimStart + delta));
        // Also move the outputStart so the clip doesn't shift
        const newOutputStart = clipOutputStart + (newTrimStart - segment.trimStart);
        trimSegment(draggedSegmentId, newTrimStart, segment.trimEnd);
        moveSegment(draggedSegmentId, newOutputStart);
      } else {
        // Trim from right: difference between clip end and mouse
        const delta = clipOutputEnd - mouseTime;
        const maxTrim = segment.originalEnd - segment.originalStart - segment.trimStart - 0.5;
        const newTrimEnd = Math.max(0, Math.min(maxTrim, segment.trimEnd + delta));
        trimSegment(draggedSegmentId, segment.trimStart, newTrimEnd);
      }
    }
  }, [isDragging, draggedSegmentId, dragStartX, dragStartOutputStart, getTimeFromX, onSeek, segments, timelineDuration, trimSegment, moveSegment]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(null);
    setDraggedSegmentId(null);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (isDragging) return;
    const time = getTimeFromX(e.clientX);
    onSeek(time);
  }, [getTimeFromX, onSeek, isDragging]);

  const handleSplit = useCallback(() => {
    // Find which segment contains the current playhead time
    for (const seg of activeSegments) {
      const clipOutputStart = seg.outputStart || 0;
      const clipDuration = seg.originalEnd - seg.originalStart - seg.trimStart - seg.trimEnd;
      const clipOutputEnd = clipOutputStart + clipDuration;

      if (currentTime >= clipOutputStart && currentTime < clipOutputEnd) {
        // Convert output time to original time
        const timeIntoClip = currentTime - clipOutputStart;
        const originalTime = seg.originalStart + seg.trimStart + timeIntoClip;

        if (originalTime > seg.originalStart + seg.trimStart + 0.1 &&
            originalTime < seg.originalEnd - seg.trimEnd - 0.1) {
          splitAtTime(originalTime);
        }
        break;
      }
    }
  }, [currentTime, activeSegments, splitAtTime]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handleSplit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSplit]);

  // Calculate output duration (sum of kept clip durations, ignoring gaps)
  const outputDuration = useMemo(() => {
    return activeSegments.reduce((sum, seg) => {
      const clipDuration = seg.originalEnd - seg.originalStart - seg.trimStart - seg.trimEnd;
      return sum + Math.max(0, clipDuration);
    }, 0);
  }, [activeSegments]);

  const playheadPercent = timelineDuration > 0 ? (currentTime / timelineDuration) * 100 : 0;
  const deletedCount = segments.filter(s => s.isDeleted).length;

  return (
    <div className="timeline-container p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-foreground-secondary font-medium">Timeline</span>
          <span className="text-xs text-foreground-muted font-mono">
            {formatTime(outputDuration)} content
          </span>
          {deletedCount > 0 && (
            <button
              className="text-[10px] text-red-400 hover:text-red-300"
              onClick={() => segments.filter(s => s.isDeleted).forEach(s => restoreSegment(s.id))}
            >
              +{deletedCount} deleted
            </button>
          )}
        </div>
        <button
          onClick={handleSplit}
          className="px-2 py-1 text-xs bg-blue-500/80 text-white rounded hover:bg-blue-500"
        >
          Split (S)
        </button>
      </div>

      {/* Time markers */}
      <div className="flex justify-between mb-1 px-0.5">
        {generateTimeMarkers(timelineDuration).map((time, i) => (
          <span key={i} className="text-[10px] text-foreground-muted font-mono">{formatTime(time)}</span>
        ))}
      </div>

      {/* Timeline track */}
      <div
        ref={timelineRef}
        className="relative h-16 bg-black/20 rounded-lg overflow-hidden cursor-pointer"
        onClick={handleTrackClick}
      >
        {/* Clips at their outputStart positions */}
        {activeSegments.map((segment, index) => {
          const clipOutputStart = segment.outputStart || 0;
          const clipDuration = segment.originalEnd - segment.originalStart - segment.trimStart - segment.trimEnd;

          const leftPercent = (clipOutputStart / timelineDuration) * 100;
          const widthPercent = (clipDuration / timelineDuration) * 100;
          const isDraggedClip = draggedSegmentId === segment.id;

          return (
            <div
              key={segment.id}
              className={`absolute top-1 bottom-1 rounded transition-shadow ${
                isDraggedClip && isDragging === 'clip' ? 'z-20 shadow-lg ring-2 ring-white/50' : 'z-10'
              }`}
              style={{
                left: `${leftPercent}%`,
                width: `${Math.max(widthPercent, 1)}%`,
                backgroundColor: `hsl(${(index * 50 + 200) % 360}, 45%, 35%)`,
              }}
            >
              {/* Left trim handle */}
              <div
                className="absolute left-0 top-0 bottom-0 w-2 bg-white/20 hover:bg-white/50 cursor-ew-resize z-10 rounded-l flex items-center justify-center"
                onMouseDown={(e) => handleMouseDown(e, 'trim-left', segment.id)}
              >
                <div className="w-0.5 h-8 bg-white/60 rounded" />
              </div>

              {/* Draggable center */}
              <div
                className="absolute inset-0 mx-2 cursor-grab active:cursor-grabbing flex items-center justify-center"
                onMouseDown={(e) => handleMouseDown(e, 'clip', segment.id)}
              >
                <span className="text-[10px] text-white/70 font-mono select-none">
                  {formatTime(clipDuration)}
                </span>
              </div>

              {/* Right trim handle */}
              <div
                className="absolute right-0 top-0 bottom-0 w-2 bg-white/20 hover:bg-white/50 cursor-ew-resize z-10 rounded-r flex items-center justify-center"
                onMouseDown={(e) => handleMouseDown(e, 'trim-right', segment.id)}
              >
                <div className="w-0.5 h-8 bg-white/60 rounded" />
              </div>

              {/* Delete button */}
              <button
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 hover:bg-red-400 rounded-full text-white text-[10px] shadow opacity-0 hover:opacity-100 z-30"
                onClick={(e) => { e.stopPropagation(); deleteSegment(segment.id); }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                ×
              </button>
            </div>
          );
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 z-40 pointer-events-none"
          style={{ left: `${playheadPercent}%` }}
        >
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 -translate-x-1/2" />
          <div
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full cursor-ew-resize pointer-events-auto"
            onMouseDown={(e) => handleMouseDown(e, 'playhead')}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-between mt-1.5 text-[10px] font-mono text-foreground-muted">
        <span>{formatTime(currentTime)}</span>
        <span className="text-foreground-secondary">Drag clips to move • Drag edges to trim</span>
      </div>
    </div>
  );
}

function generateTimeMarkers(duration: number): number[] {
  if (!duration || duration <= 0) return [0];
  const count = Math.min(6, Math.max(2, Math.ceil(duration / 15) + 1));
  return Array.from({ length: count }, (_, i) => (i / (count - 1)) * duration);
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
