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
    <div className="timeline-container p-3">
      {/* Time markers - monospace, subtle */}
      <div className="flex justify-between mb-2 px-0.5">
        {generateTimeMarkers(duration).map((time, i) => (
          <span key={i} className="time-marker">{formatTime(time)}</span>
        ))}
      </div>

      {/* Timeline track */}
      <div
        ref={timelineRef}
        className="timeline-track cursor-pointer"
        onClick={handleTrackClick}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onMouseMove={handleTrackMouseMove}
      >
        {/* Waveform */}
        <div className="absolute inset-0">
          <WaveformPlaceholder />
        </div>

        {/* Trimmed out areas (darkened) */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-background/70 backdrop-blur-[1px] rounded-l-md"
          style={{ width: `${trimStartPercent}%` }}
        />
        <div
          className="absolute top-0 bottom-0 right-0 bg-background/70 backdrop-blur-[1px] rounded-r-md"
          style={{ width: `${100 - trimEndPercent}%` }}
        />

        {/* Visual selection markers */}
        {visualSelections.map((selection) => {
          const startPercent = (selection.startTime / duration) * 100;
          const endPercent = (selection.endTime / duration) * 100;
          return (
            <div
              key={selection.id}
              className="absolute top-1 bottom-1 bg-accent/20 border-l-2 border-r-2 border-accent/60 rounded-sm"
              style={{
                left: `${startPercent}%`,
                width: `${endPercent - startPercent}%`,
              }}
            />
          );
        })}

        {/* Trim handles - refined */}
        <div
          className="absolute top-0 bottom-0 w-2.5 bg-primary hover:bg-primary-hover cursor-ew-resize flex items-center justify-center rounded-l transition-colors duration-150"
          style={{ left: `${trimStartPercent}%`, transform: 'translateX(-50%)' }}
          onMouseDown={(e) => handleMouseDown(e, 'trimStart')}
        >
          <div className="w-px h-5 bg-white/40 rounded-full" />
        </div>
        <div
          className="absolute top-0 bottom-0 w-2.5 bg-primary hover:bg-primary-hover cursor-ew-resize flex items-center justify-center rounded-r transition-colors duration-150"
          style={{ left: `${trimEndPercent}%`, transform: 'translateX(-50%)' }}
          onMouseDown={(e) => handleMouseDown(e, 'trimEnd')}
        >
          <div className="w-px h-5 bg-white/40 rounded-full" />
        </div>

        {/* Hover indicator */}
        {isHovering && !isDragging && (
          <div
            className="absolute top-0 bottom-0 w-px bg-foreground/20 pointer-events-none transition-opacity duration-100"
            style={{ left: `${hoverPercent}%` }}
          >
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-surface-elevated border border-border-subtle px-2 py-0.5 rounded text-xs font-mono text-foreground-secondary whitespace-nowrap shadow-subtle">
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

      {/* Trim info - cleaner layout */}
      <div className="flex items-center justify-between mt-2 text-xs font-mono">
        <div className="flex items-center gap-3">
          <span className="text-foreground-muted">
            <span className="text-foreground-secondary">In:</span> {formatTime(trimStart)}
          </span>
          <span className="text-foreground-muted">
            <span className="text-foreground-secondary">Out:</span> {formatTime(trimEnd)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-foreground-secondary">
            {formatTime(trimEnd - trimStart)}
          </span>
          {visualSelections.length > 0 && (
            <span className="text-accent/80 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/60" />
              {visualSelections.length} edit{visualSelections.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function WaveformPlaceholder() {
  // Generate random heights for visual effect - seeded for consistency
  const bars = 120;
  return (
    <div className="waveform-container h-full flex items-center gap-px px-1.5">
      {Array.from({ length: bars }).map((_, i) => {
        // Use sine wave with noise for more natural waveform look
        const base = Math.sin(i * 0.15) * 0.3 + 0.5;
        const noise = Math.sin(i * 0.7) * 0.15 + Math.sin(i * 1.3) * 0.1;
        const height = Math.max(15, Math.min(85, (base + noise) * 100));
        return (
          <div
            key={i}
            className="flex-1 bg-primary/30 rounded-[1px] transition-all duration-75"
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
