'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { VisualSelection } from './VideoEditor';
import { useEditorStore } from '@/lib/store';

interface VisualSelectorProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  currentTime: number;
  selections: VisualSelection[];
  onAddSelection: (selection: Omit<VisualSelection, 'id'>) => void;
  onUpdateSelection: (id: string, updates: Partial<VisualSelection>) => void;
  onDeleteSelection: (id: string) => void;
  highlightedId?: string | null;
  onHighlight?: (id: string | null) => void;
  showDetectionBoxes?: boolean;
}

export function VisualSelector({
  videoRef,
  currentTime,
  selections,
  onAddSelection,
  onUpdateSelection,
  onDeleteSelection,
  highlightedId,
  onHighlight,
  showDetectionBoxes = true,
}: VisualSelectorProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [currentDraw, setCurrentDraw] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [selectedSelectionId, setSelectedSelectionId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; handle: string } | null>(null);

  // Vision API state from store
  const {
    analysis,
    isAnalyzing,
    analyzeError,
    analyzeVideo,
    videoId,
  } = useEditorStore();

  // Get detected items at current timestamp
  const currentFrameAnalysis = analysis?.frames.find(f =>
    Math.abs(f.timestamp - currentTime) < 1.0 // Within 1 second
  );

  // Helper to validate and clamp coordinates to 0-100 range
  // Also filters out invalid/malformed detections
  const validateCoords = <T extends { x: number; y: number; width: number; height: number }>(
    items: T[]
  ): T[] => {
    return items
      .filter(item => {
        // Filter out items with invalid coordinates (NaN, undefined, null, or wildly out of range)
        const isValid =
          typeof item.x === 'number' && isFinite(item.x) &&
          typeof item.y === 'number' && isFinite(item.y) &&
          typeof item.width === 'number' && isFinite(item.width) && item.width > 0 &&
          typeof item.height === 'number' && isFinite(item.height) && item.height > 0;
        return isValid;
      })
      .map(item => ({
        ...item,
        // Clamp coordinates to valid 0-100 range
        x: Math.max(0, Math.min(100, item.x)),
        y: Math.max(0, Math.min(100, item.y)),
        width: Math.max(0.1, Math.min(100 - Math.max(0, item.x), item.width)),
        height: Math.max(0.1, Math.min(100 - Math.max(0, item.y), item.height)),
      }));
  };

  const detectedObjects = validateCoords(currentFrameAnalysis?.objects || []);
  const detectedTexts = validateCoords(currentFrameAnalysis?.texts || []);
  const detectedLogos = validateCoords(currentFrameAnalysis?.logos || []);

  // Add detected item as a selection
  const handleAddDetectedItem = useCallback((item: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    text?: string;
  }, type: 'object' | 'text' | 'logo') => {
    onAddSelection({
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      startTime: currentTime,
      endTime: currentTime + 5,
      type: 'detected',
      label: item.name || item.text || `Detected ${type}`,
    });
  }, [currentTime, onAddSelection]);

  // Get video dimensions for coordinate conversion
  const getVideoDimensions = useCallback(() => {
    if (!videoRef.current) return { width: 1, height: 1 };
    return {
      width: videoRef.current.videoWidth || videoRef.current.offsetWidth,
      height: videoRef.current.videoHeight || videoRef.current.offsetHeight,
    };
  }, [videoRef]);

  const getRelativeCoords = useCallback((clientX: number, clientY: number) => {
    if (!overlayRef.current) return { x: 0, y: 0 };
    const rect = overlayRef.current.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target !== overlayRef.current) return;

    const coords = getRelativeCoords(e.clientX, e.clientY);
    setIsDrawing(true);
    setDrawStart(coords);
    setCurrentDraw({ ...coords, width: 0, height: 0 });
    setSelectedSelectionId(null);
  }, [getRelativeCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing || !drawStart) return;

    const coords = getRelativeCoords(e.clientX, e.clientY);
    const x = Math.min(drawStart.x, coords.x);
    const y = Math.min(drawStart.y, coords.y);
    const width = Math.abs(coords.x - drawStart.x);
    const height = Math.abs(coords.y - drawStart.y);

    setCurrentDraw({ x, y, width, height });
  }, [isDrawing, drawStart, getRelativeCoords]);

  const handleMouseUp = useCallback(() => {
    if (currentDraw && currentDraw.width > 2 && currentDraw.height > 2) {
      onAddSelection({
        x: currentDraw.x,
        y: currentDraw.y,
        width: currentDraw.width,
        height: currentDraw.height,
        startTime: currentTime,
        endTime: currentTime + 5, // Default 5 second duration
        type: 'manual',
      });
    }

    setIsDrawing(false);
    setDrawStart(null);
    setCurrentDraw(null);
  }, [currentDraw, currentTime, onAddSelection]);

  const handleSelectionClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedSelectionId(selectedSelectionId === id ? null : id);
  }, [selectedSelectionId]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedSelectionId) {
      onDeleteSelection(selectedSelectionId);
      setSelectedSelectionId(null);
    }
  }, [selectedSelectionId, onDeleteSelection]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept keyboard events when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedSelectionId) {
          e.preventDefault();
          handleDeleteSelected();
        }
      } else if (e.key === 'Escape') {
        setSelectedSelectionId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSelectionId, handleDeleteSelected]);

  // Filter selections visible at current time
  const visibleSelections = selections.filter(
    s => currentTime >= s.startTime && currentTime <= s.endTime
  );

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Instructions overlay with auto-detect button */}
      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm px-3 py-2 rounded-lg text-sm">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-white/80">Draw to select an area</p>
            <p className="text-white/50 text-xs mt-1">Click selection to edit • Delete to remove</p>
          </div>
          <button
            onClick={() => analyzeVideo()}
            disabled={isAnalyzing || !videoId}
            className="px-3 py-1.5 bg-primary text-white rounded text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {isAnalyzing ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Analyzing...
              </>
            ) : analysis ? (
              <>
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Re-analyze
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Auto-detect
              </>
            )}
          </button>
        </div>
        {analyzeError && (
          <p className="text-red-400 text-xs mt-1">{analyzeError}</p>
        )}
        {analysis && (
          <p className="text-green-400 text-xs mt-1">
            Found: {analysis.unique_objects.length} objects, {analysis.unique_texts.length} texts
          </p>
        )}
      </div>

      {/* Detected objects from Vision API */}
      {showDetectionBoxes && detectedObjects.map((obj) => {
        const isHighlighted = highlightedId === obj.id;
        return (
          <div
            key={obj.id}
            className={`absolute border-2 border-dashed cursor-pointer transition-all ${
              isHighlighted
                ? 'border-yellow-400 bg-yellow-400/30 scale-[1.02] z-10'
                : 'border-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20'
            }`}
            style={{
              left: `${obj.x}%`,
              top: `${obj.y}%`,
              width: `${obj.width}%`,
              height: `${obj.height}%`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Toggle highlight - clicking locks the highlight so user can find it in panel
              onHighlight?.(isHighlighted ? null : obj.id);
            }}
            onMouseEnter={() => !highlightedId && onHighlight?.(obj.id)}
            onMouseLeave={() => !highlightedId && onHighlight?.(null)}
            title={`Click to highlight: ${obj.name}`}
          >
            <span className={`absolute -top-5 left-0 bg-yellow-400 text-black px-1 py-0.5 rounded text-xs font-medium ${isHighlighted ? 'ring-2 ring-white' : ''}`}>
              {obj.name}
            </span>
          </div>
        );
      })}

      {/* Detected text from Vision API */}
      {showDetectionBoxes && detectedTexts.map((txt) => {
        const isHighlighted = highlightedId === txt.id;
        return (
          <div
            key={txt.id}
            className={`absolute border-2 border-dashed cursor-pointer transition-all ${
              isHighlighted
                ? 'border-blue-400 bg-blue-400/30 scale-[1.02] z-10'
                : 'border-blue-400 bg-blue-400/10 hover:bg-blue-400/20'
            }`}
            style={{
              left: `${txt.x}%`,
              top: `${txt.y}%`,
              width: `${txt.width}%`,
              height: `${txt.height}%`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Toggle highlight - clicking locks the highlight so user can find it in panel
              onHighlight?.(isHighlighted ? null : txt.id);
            }}
            onMouseEnter={() => !highlightedId && onHighlight?.(txt.id)}
            onMouseLeave={() => !highlightedId && onHighlight?.(null)}
            title={`Click to highlight: "${txt.text}"`}
          >
            <span className={`absolute -top-5 left-0 bg-blue-400 text-black px-1 py-0.5 rounded text-xs font-medium truncate max-w-[100px] ${isHighlighted ? 'ring-2 ring-white' : ''}`}>
              "{txt.text}"
            </span>
          </div>
        );
      })}

      {/* Detected logos from Vision API */}
      {showDetectionBoxes && detectedLogos.map((logo) => {
        const isHighlighted = highlightedId === logo.id;
        return (
          <div
            key={logo.id}
            className={`absolute border-2 border-dashed cursor-pointer transition-all ${
              isHighlighted
                ? 'border-purple-400 bg-purple-400/30 scale-[1.02] z-10'
                : 'border-purple-400 bg-purple-400/10 hover:bg-purple-400/20'
            }`}
            style={{
              left: `${logo.x}%`,
              top: `${logo.y}%`,
              width: `${logo.width}%`,
              height: `${logo.height}%`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Toggle highlight - clicking locks the highlight so user can find it in panel
              onHighlight?.(isHighlighted ? null : logo.id);
            }}
            onMouseEnter={() => !highlightedId && onHighlight?.(logo.id)}
            onMouseLeave={() => !highlightedId && onHighlight?.(null)}
            title={`Click to highlight: ${logo.name}`}
          >
            <span className={`absolute -top-5 left-0 bg-purple-400 text-black px-1 py-0.5 rounded text-xs font-medium ${isHighlighted ? 'ring-2 ring-white' : ''}`}>
              {logo.name}
            </span>
          </div>
        );
      })}

      {/* Current drawing */}
      {currentDraw && (
        <div
          className="selection-overlay"
          style={{
            left: `${currentDraw.x}%`,
            top: `${currentDraw.y}%`,
            width: `${currentDraw.width}%`,
            height: `${currentDraw.height}%`,
          }}
        />
      )}

      {/* Existing selections */}
      {visibleSelections.map((selection) => (
        <SelectionBox
          key={selection.id}
          selection={selection}
          isSelected={selectedSelectionId === selection.id}
          onClick={(e) => handleSelectionClick(e, selection.id)}
          onUpdate={(updates) => onUpdateSelection(selection.id, updates)}
          onDelete={() => onDeleteSelection(selection.id)}
        />
      ))}

      {/* Selection controls */}
      {selectedSelectionId && (
        <SelectionControls
          selection={selections.find(s => s.id === selectedSelectionId)!}
          onUpdate={(updates) => onUpdateSelection(selectedSelectionId, updates)}
          onDelete={handleDeleteSelected}
        />
      )}
    </div>
  );
}

interface SelectionBoxProps {
  selection: VisualSelection;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onUpdate: (updates: Partial<VisualSelection>) => void;
  onDelete: () => void;
}

function SelectionBox({ selection, isSelected, onClick, onUpdate, onDelete }: SelectionBoxProps) {
  return (
    <div
      className={`selection-overlay ${isSelected ? 'border-accent' : ''}`}
      style={{
        left: `${selection.x}%`,
        top: `${selection.y}%`,
        width: `${selection.width}%`,
        height: `${selection.height}%`,
        pointerEvents: 'auto',
        cursor: 'pointer',
      }}
      onClick={onClick}
    >
      {/* Label */}
      {selection.label && (
        <div className="absolute -top-6 left-0 bg-primary px-2 py-0.5 rounded text-xs text-white">
          {selection.label}
        </div>
      )}

      {/* Resize handles (only when selected) */}
      {isSelected && (
        <>
          <div className="selection-handle -top-1 -left-1 cursor-nw-resize" />
          <div className="selection-handle -top-1 -right-1 cursor-ne-resize" />
          <div className="selection-handle -bottom-1 -left-1 cursor-sw-resize" />
          <div className="selection-handle -bottom-1 -right-1 cursor-se-resize" />
        </>
      )}
    </div>
  );
}

interface SelectionControlsProps {
  selection: VisualSelection;
  onUpdate: (updates: Partial<VisualSelection>) => void;
  onDelete: () => void;
}

function SelectionControls({ selection, onUpdate, onDelete }: SelectionControlsProps) {
  const [label, setLabel] = useState(selection.label || '');
  const [replacementText, setReplacementText] = useState(selection.replacementValue || '');
  const [replacementType, setReplacementType] = useState<'text' | 'blur' | 'remove'>(
    selection.replacementType || 'text'
  );

  const handleReplacementChange = (value: string) => {
    setReplacementText(value);
    onUpdate({ replacementType: 'text', replacementValue: value });
  };

  const handleTypeChange = (type: 'text' | 'blur' | 'remove') => {
    setReplacementType(type);
    onUpdate({ replacementType: type, replacementValue: type === 'blur' || type === 'remove' ? type : replacementText });
  };

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg shadow-xl p-3 flex flex-col gap-3 min-w-[400px]">
      {/* Row 1: Label and Original Text */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted">Original:</label>
          <span className="text-sm text-foreground bg-secondary px-2 py-1 rounded truncate max-w-[150px]">
            {selection.label || 'Selected region'}
          </span>
        </div>

        {/* Time range */}
        <div className="flex items-center gap-2 border-l border-border pl-3">
          <label className="text-xs text-muted">Time:</label>
          <span className="text-xs text-muted">
            {selection.startTime.toFixed(1)}s - {selection.endTime.toFixed(1)}s
          </span>
        </div>
      </div>

      {/* Row 2: Replacement Type and Value */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted">Replace with:</label>
          <select
            value={replacementType}
            onChange={(e) => handleTypeChange(e.target.value as 'text' | 'blur' | 'remove')}
            className="bg-secondary rounded px-2 py-1 text-sm outline-none focus:ring-1 ring-primary"
          >
            <option value="text">Text</option>
            <option value="blur">Blur</option>
            <option value="remove">Remove</option>
          </select>
        </div>

        {replacementType === 'text' && (
          <div className="flex-1">
            <input
              type="text"
              value={replacementText}
              onChange={(e) => handleReplacementChange(e.target.value)}
              placeholder="Enter replacement text..."
              className="w-full bg-secondary rounded px-2 py-1 text-sm outline-none focus:ring-1 ring-primary"
            />
          </div>
        )}

        {/* Delete button */}
        <button
          onClick={onDelete}
          className="p-2 rounded hover:bg-danger/20 text-danger transition-colors"
          title="Delete selection"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      {/* Row 3: Tracking option and Status */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selection.enableTracking || false}
            onChange={(e) => onUpdate({ enableTracking: e.target.checked })}
            className="w-4 h-4 rounded border-border bg-secondary accent-primary"
          />
          <span className="text-xs text-muted">Track movement (for moving objects)</span>
        </label>

        {/* Status indicator */}
        {(replacementText || replacementType === 'blur' || replacementType === 'remove') && (
          <div className="text-xs text-green-500 flex items-center gap-1 ml-auto">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Ready to render
          </div>
        )}
      </div>
    </div>
  );
}
