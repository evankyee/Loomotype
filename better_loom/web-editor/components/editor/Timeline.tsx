'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
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
  trimStart,
  trimEnd,
  onSeek,
  onTrimStartChange,
  onTrimEndChange,
  visualSelections,
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<'playhead' | 'trimStart' | 'trimEnd' | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [hoverTime, setHoverTime] = useState(0);

  const getTimeFromPosition = useCallback((clientX: number): number => {
    if (!timelineRef.current || duration === 0 || !isFinite(duration)) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    return percentage * duration;
  }, [duration]);

  const handleMouseDown = useCallback((e: React.MouseEvent, type: 'playhead' | 'trimStart' | 'trimEnd') => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(type);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;

    const time = getTimeFromPosition(e.clientX);

    switch (isDragging) {
      case 'playhead':
        onSeek(time);
        break;
      case 'trimStart':
        if (isFinite(time) && isFinite(trimEnd)) {
          onTrimStartChange(Math.min(time, trimEnd - 0.5));
        }
        break;
      case 'trimEnd':
        if (isFinite(time) && isFinite(trimStart)) {
          onTrimEndChange(Math.max(time, trimStart + 0.5));
        }
        break;
    }
  }, [isDragging, getTimeFromPosition, onSeek, onTrimStartChange, onTrimEndChange, trimStart, trimEnd]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(null);
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
    const time = getTimeFromPosition(e.clientX);
    onSeek(time);
  }, [getTimeFromPosition, onSeek]);

  const handleTrackMouseMove = useCallback((e: React.MouseEvent) => {
    const time = getTimeFromPosition(e.clientX);
    setHoverTime(time);
  }, [getTimeFromPosition]);

  const trimStartPercent = duration > 0 ? (trimStart / duration) * 100 : 0;
  const trimEndPercent = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const hoverPercent = duration > 0 ? (hoverTime / duration) * 100 : 0;

  return (
    <div className="bg-card border-t border-border p-4">
      {/* Time markers */}
      <div className="flex justify-between text-xs text-muted mb-2 px-1">
        {generateTimeMarkers(duration).map((time, i) => (
          <span key={i}>{formatTime(time)}</span>
        ))}
      </div>

      {/* Timeline track */}
      <div
        ref={timelineRef}
        className="relative h-16 bg-secondary rounded-lg cursor-pointer"
        onClick={handleTrackClick}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onMouseMove={handleTrackMouseMove}
      >
        {/* Waveform placeholder */}
        <div className="absolute inset-0 opacity-30">
          <WaveformPlaceholder />
        </div>

        {/* Trimmed out areas (darkened) */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-black/60 rounded-l-lg"
          style={{ width: `${trimStartPercent}%` }}
        />
        <div
          className="absolute top-0 bottom-0 right-0 bg-black/60 rounded-r-lg"
          style={{ width: `${100 - trimEndPercent}%` }}
        />

        {/* Visual selection markers */}
        {visualSelections.map((selection) => {
          const startPercent = (selection.startTime / duration) * 100;
          const endPercent = (selection.endTime / duration) * 100;
          return (
            <div
              key={selection.id}
              className="absolute top-1 bottom-1 bg-accent/30 border-l-2 border-r-2 border-accent"
              style={{
                left: `${startPercent}%`,
                width: `${endPercent - startPercent}%`,
              }}
            />
          );
        })}

        {/* Trim handles */}
        <div
          className="absolute top-0 bottom-0 w-3 bg-primary cursor-ew-resize flex items-center justify-center rounded-l"
          style={{ left: `${trimStartPercent}%`, transform: 'translateX(-50%)' }}
          onMouseDown={(e) => handleMouseDown(e, 'trimStart')}
        >
          <div className="w-0.5 h-6 bg-white/50 rounded" />
        </div>
        <div
          className="absolute top-0 bottom-0 w-3 bg-primary cursor-ew-resize flex items-center justify-center rounded-r"
          style={{ left: `${trimEndPercent}%`, transform: 'translateX(-50%)' }}
          onMouseDown={(e) => handleMouseDown(e, 'trimEnd')}
        >
          <div className="w-0.5 h-6 bg-white/50 rounded" />
        </div>

        {/* Hover indicator */}
        {isHovering && !isDragging && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white/30 pointer-events-none"
            style={{ left: `${hoverPercent}%` }}
          >
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-card px-2 py-1 rounded text-xs whitespace-nowrap">
              {formatTime(hoverTime)}
            </div>
          </div>
        )}

        {/* Playhead */}
        <div
          className="timeline-playhead"
          style={{ left: `${playheadPercent}%` }}
          onMouseDown={(e) => handleMouseDown(e, 'playhead')}
        />
      </div>

      {/* Trim info */}
      <div className="flex justify-between items-center mt-2 text-xs">
        <span className="text-muted">
          Trim: {formatTime(trimStart)} - {formatTime(trimEnd)}
        </span>
        <span className="text-muted">
          Duration: {formatTime(trimEnd - trimStart)}
        </span>
        {visualSelections.length > 0 && (
          <span className="text-accent">
            {visualSelections.length} selection{visualSelections.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function WaveformPlaceholder() {
  // Generate random heights for visual effect
  const bars = 100;
  return (
    <div className="h-full flex items-center gap-px px-2">
      {Array.from({ length: bars }).map((_, i) => {
        const height = 20 + Math.random() * 60;
        return (
          <div
            key={i}
            className="flex-1 bg-primary/40 rounded-sm"
            style={{ height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}

function generateTimeMarkers(duration: number): number[] {
  // Guard against invalid duration values
  if (!duration || duration <= 0 || !isFinite(duration) || isNaN(duration)) {
    return [0];
  }

  // Cap duration to prevent infinite loops
  const safeDuration = Math.min(duration, 36000); // Max 10 hours

  const markers: number[] = [];
  const interval = safeDuration <= 30 ? 5 : safeDuration <= 120 ? 15 : 30;

  for (let t = 0; t <= safeDuration; t += interval) {
    markers.push(t);
    // Safety check to prevent runaway loops
    if (markers.length > 1000) break;
  }

  // Always include the end
  if (markers[markers.length - 1] !== safeDuration) {
    markers.push(safeDuration);
  }

  return markers;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) {
    return '0:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
