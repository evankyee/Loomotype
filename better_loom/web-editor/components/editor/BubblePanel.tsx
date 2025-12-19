'use client';

import { useState, useCallback, useEffect } from 'react';
import { api, BubbleSettings, BubbleVisibility } from '@/lib/api';

interface BubblePanelProps {
  videoId: string;
  duration: number;
  currentTime: number;
  onCompositeStart: (jobId: string) => void;
  onCompositeComplete: (outputUrl: string) => void;
  onCompositeError: (error: string) => void;
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
  videoId,
  duration,
  currentTime,
  onCompositeStart,
  onCompositeComplete,
  onCompositeError,
}: BubblePanelProps) {
  const [hasCamera, setHasCamera] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCompositing, setIsCompositing] = useState(false);
  const [progress, setProgress] = useState(0);

  // Bubble settings
  const [position, setPosition] = useState<BubbleSettings['position']>('bottom-left');
  const [size, setSize] = useState(0.25);
  const [shape, setShape] = useState<BubbleSettings['shape']>('circle');
  const [visibility, setVisibility] = useState<BubbleVisibility[]>([]);

  // New visibility segment being added
  const [newSegmentStart, setNewSegmentStart] = useState<number | null>(null);

  // Check if video has separate camera
  useEffect(() => {
    async function checkCamera() {
      try {
        const info = await api.getVideoInfo(videoId);
        setHasCamera(info.has_camera);
        if (info.bubble_settings) {
          setPosition(info.bubble_settings.position);
          setSize(info.bubble_settings.size);
          setShape(info.bubble_settings.shape);
          setVisibility(info.bubble_settings.visibility || []);
        }
      } catch (err) {
        console.error('Failed to get video info:', err);
      } finally {
        setIsLoading(false);
      }
    }
    checkCamera();
  }, [videoId]);

  // Add visibility segment at current time
  const handleAddVisibilitySegment = useCallback(() => {
    if (newSegmentStart === null) {
      // Start marking segment
      setNewSegmentStart(currentTime);
    } else {
      // End segment
      const start = Math.min(newSegmentStart, currentTime);
      const end = Math.max(newSegmentStart, currentTime);
      setVisibility(prev => [...prev, { start, end, visible: false }]);
      setNewSegmentStart(null);
    }
  }, [currentTime, newSegmentStart]);

  // Remove visibility segment
  const handleRemoveSegment = useCallback((index: number) => {
    setVisibility(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Apply bubble settings
  const handleApply = useCallback(async (preview: boolean = false) => {
    setIsCompositing(true);
    setProgress(0);

    try {
      const settings: BubbleSettings = {
        position,
        size,
        shape,
        visibility,
      };

      const result = await api.compositeBubble(videoId, settings, preview);
      onCompositeStart(result.job_id);

      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const status = await api.getRenderStatus(result.job_id);
          setProgress(status.progress);

          if (status.status === 'completed' && status.output_url) {
            clearInterval(pollInterval);
            setIsCompositing(false);
            onCompositeComplete(status.output_url);
          } else if (status.status === 'failed') {
            clearInterval(pollInterval);
            setIsCompositing(false);
            onCompositeError(status.error || 'Compositing failed');
          }
        } catch (err) {
          clearInterval(pollInterval);
          setIsCompositing(false);
          onCompositeError(err instanceof Error ? err.message : 'Polling failed');
        }
      }, 1500);
    } catch (err) {
      setIsCompositing(false);
      onCompositeError(err instanceof Error ? err.message : 'Compositing failed');
    }
  }, [videoId, position, size, shape, visibility, onCompositeStart, onCompositeComplete, onCompositeError]);

  // Format time as M:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (isLoading) {
    return (
      <div className="p-4 text-center text-foreground-secondary">
        Loading...
      </div>
    );
  }

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

      {/* Position */}
      <div className="space-y-2">
        <label className="text-xs text-foreground-secondary">Position</label>
        <div className="grid grid-cols-2 gap-2">
          {POSITIONS.map(pos => (
            <button
              key={pos.id}
              onClick={() => setPosition(pos.id)}
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
              onClick={() => setSize(preset.value)}
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
          onChange={e => setSize(parseFloat(e.target.value))}
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
              onClick={() => setShape(s.id)}
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

      {/* Apply Buttons */}
      <div className="space-y-2 pt-2 border-t border-border-subtle">
        {isCompositing ? (
          <div className="space-y-2">
            <div className="h-2 bg-background-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-center text-foreground-secondary">
              Compositing... {progress}%
            </div>
          </div>
        ) : (
          <>
            <button
              onClick={() => handleApply(true)}
              className="w-full px-4 py-2 rounded-md text-sm font-medium glass-subtle text-foreground-secondary hover:text-foreground transition-all"
            >
              Preview
            </button>
            <button
              onClick={() => handleApply(false)}
              className="w-full px-4 py-2 rounded-md text-sm font-medium bg-primary text-white hover:bg-primary-hover transition-all"
            >
              Apply Changes
            </button>
          </>
        )}
      </div>
    </div>
  );
}
