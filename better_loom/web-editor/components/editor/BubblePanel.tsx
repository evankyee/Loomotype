'use client';

import { useState, useCallback } from 'react';
import { BubbleSettings, BubbleVisibility } from '@/lib/api';

interface BubblePanelProps {
  videoId: string;
  duration: number;
  currentTime: number;
  hasCamera: boolean;
  // Controlled state from parent
  position: BubbleSettings['position'];
  size: number;
  shape: BubbleSettings['shape'];
  visibility: BubbleVisibility[];
  // State setters from parent
  onPositionChange: (position: BubbleSettings['position']) => void;
  onSizeChange: (size: number) => void;
  onShapeChange: (shape: BubbleSettings['shape']) => void;
  onVisibilityChange: (visibility: BubbleVisibility[]) => void;
}

const POSITIONS = [
  { id: 'bottom-left', label: 'Bottom Left' },
  { id: 'bottom-right', label: 'Bottom Right' },
  { id: 'top-left', label: 'Top Left' },
  { id: 'top-right', label: 'Top Right' },
] as const;

const SHAPES = [
  { id: 'circle', label: 'Circle' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'square', label: 'Square' },
] as const;

const SIZE_PRESETS = [
  { id: 'small', label: 'S', value: 0.15 },
  { id: 'medium', label: 'M', value: 0.25 },
  { id: 'large', label: 'L', value: 0.35 },
] as const;

export function BubblePanel({
  duration,
  currentTime,
  hasCamera,
  position,
  size,
  shape,
  visibility,
  onPositionChange,
  onSizeChange,
  onShapeChange,
  onVisibilityChange,
}: BubblePanelProps) {
  // New visibility segment being added (local UI state only)
  const [newSegmentStart, setNewSegmentStart] = useState<number | null>(null);

  // Add visibility segment at current time
  const handleAddVisibilitySegment = useCallback(() => {
    if (newSegmentStart === null) {
      // Start marking segment
      setNewSegmentStart(currentTime);
    } else {
      // End segment
      const start = Math.min(newSegmentStart, currentTime);
      const end = Math.max(newSegmentStart, currentTime);
      onVisibilityChange([...visibility, { start, end, visible: false }]);
      setNewSegmentStart(null);
    }
  }, [currentTime, newSegmentStart, visibility, onVisibilityChange]);

  // Remove visibility segment
  const handleRemoveSegment = useCallback((index: number) => {
    onVisibilityChange(visibility.filter((_, i) => i !== index));
  }, [visibility, onVisibilityChange]);

  // Format time as M:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!hasCamera) {
    return (
      <div className="p-4">
        <div className="glass-subtle rounded-lg p-4 text-center">
          <div className="text-foreground-secondary text-sm mb-2">
            No Camera Track
          </div>
          <p className="text-xs text-foreground-tertiary">
            This video was recorded without a separate camera track.
            Bubble controls are only available for window-mode recordings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="text-sm font-medium text-foreground">Camera Bubble</div>

      {/* Info banner about accumulative editing */}
      <div className="text-xs text-foreground-tertiary bg-surface-elevated rounded-md p-2">
        Changes here are included when you click Preview. You can combine bubble edits with voice and visual edits.
      </div>

      {/* Position */}
      <div className="space-y-2">
        <label className="text-xs text-foreground-secondary">Position</label>
        <div className="grid grid-cols-2 gap-2">
          {POSITIONS.map(pos => (
            <button
              key={pos.id}
              onClick={() => onPositionChange(pos.id)}
              className={`px-3 py-2 rounded-md text-xs font-medium transition-all ${
                position === pos.id
                  ? 'bg-primary text-white'
                  : 'glass-subtle text-foreground-secondary hover:text-foreground'
              }`}
            >
              {pos.label}
            </button>
          ))}
        </div>
      </div>

      {/* Size */}
      <div className="space-y-2">
        <label className="text-xs text-foreground-secondary">Size</label>
        <div className="flex gap-2">
          {SIZE_PRESETS.map(preset => (
            <button
              key={preset.id}
              onClick={() => onSizeChange(preset.value)}
              className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                Math.abs(size - preset.value) < 0.01
                  ? 'bg-primary text-white'
                  : 'glass-subtle text-foreground-secondary hover:text-foreground'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <input
          type="range"
          min="0.1"
          max="0.5"
          step="0.01"
          value={size}
          onChange={e => onSizeChange(parseFloat(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="text-xs text-foreground-tertiary text-center">
          {Math.round(size * 100)}% of screen width
        </div>
      </div>

      {/* Shape */}
      <div className="space-y-2">
        <label className="text-xs text-foreground-secondary">Shape</label>
        <div className="flex gap-2">
          {SHAPES.map(s => (
            <button
              key={s.id}
              onClick={() => onShapeChange(s.id)}
              className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                shape === s.id
                  ? 'bg-primary text-white'
                  : 'glass-subtle text-foreground-secondary hover:text-foreground'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Visibility (Hide Segments) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-foreground-secondary">Hide Bubble</label>
          <button
            onClick={handleAddVisibilitySegment}
            className={`px-2 py-1 rounded text-xs font-medium transition-all ${
              newSegmentStart !== null
                ? 'bg-warning text-white'
                : 'glass-subtle text-foreground-secondary hover:text-foreground'
            }`}
          >
            {newSegmentStart !== null
              ? `End at ${formatTime(currentTime)}`
              : `Start at ${formatTime(currentTime)}`}
          </button>
        </div>

        {newSegmentStart !== null && (
          <div className="glass-subtle rounded-md p-2 text-xs text-foreground-secondary">
            Marking from {formatTime(newSegmentStart)}... Seek to end point and click button.
          </div>
        )}

        {visibility.length > 0 && (
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {visibility.map((seg, i) => (
              <div
                key={i}
                className="flex items-center justify-between glass-subtle rounded-md px-2 py-1.5"
              >
                <span className="text-xs text-foreground-secondary">
                  Hidden: {formatTime(seg.start)} - {formatTime(seg.end)}
                </span>
                <button
                  onClick={() => handleRemoveSegment(i)}
                  className="text-xs text-danger hover:text-danger-hover"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
