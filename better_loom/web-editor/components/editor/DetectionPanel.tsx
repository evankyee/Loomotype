'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useEditorStore } from '@/lib/store';
import type { VisualSelection } from './VideoEditor';

interface DetectionPanelProps {
  currentTime: number;
  selections: VisualSelection[];
  onAddSelection: (selection: Omit<VisualSelection, 'id'>) => void;
  onUpdateSelection: (id: string, updates: Partial<VisualSelection>) => void;
  onDeleteSelection: (id: string) => void;
  highlightedId: string | null;
  onHighlight: (id: string | null) => void;
}

interface DetectedItemWithReplacement {
  id: string;
  text: string;
  type: 'text' | 'object' | 'logo';
  x: number;
  y: number;
  width: number;
  height: number;
  timestamp: number;
  confidence: number;
  replacement?: string;
  selectionId?: string;
}

export function DetectionPanel({
  currentTime,
  selections,
  onAddSelection,
  onUpdateSelection,
  onDeleteSelection,
  highlightedId,
  onHighlight,
}: DetectionPanelProps) {
  const { analysis, isAnalyzing, analyzeVideo, videoId } = useEditorStore();
  const [activeTab, setActiveTab] = useState<'text' | 'objects' | 'selections'>('text');
  const [replacements, setReplacements] = useState<Record<string, string>>({});

  // Refs for scrolling to items
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to highlighted item when it changes
  useEffect(() => {
    if (highlightedId && itemRefs.current[highlightedId]) {
      itemRefs.current[highlightedId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [highlightedId]);

  // Get all unique detected items across all frames
  const allDetectedItems = useMemo(() => {
    if (!analysis?.frames) return { texts: [], objects: [], logos: [] };

    const textsMap = new Map<string, DetectedItemWithReplacement>();
    const objectsMap = new Map<string, DetectedItemWithReplacement>();
    const logosMap = new Map<string, DetectedItemWithReplacement>();

    for (const frame of analysis.frames) {
      // Texts - group by text content
      for (const txt of frame.texts || []) {
        const key = txt.text.toLowerCase().trim();
        if (!textsMap.has(key) || Math.abs(frame.timestamp - currentTime) < Math.abs(textsMap.get(key)!.timestamp - currentTime)) {
          textsMap.set(key, {
            id: txt.id,
            text: txt.text,
            type: 'text',
            x: txt.x,
            y: txt.y,
            width: txt.width,
            height: txt.height,
            timestamp: frame.timestamp,
            confidence: txt.confidence,
          });
        }
      }

      // Objects - group by name
      for (const obj of frame.objects || []) {
        const key = obj.name.toLowerCase().trim();
        if (!objectsMap.has(key) || Math.abs(frame.timestamp - currentTime) < Math.abs(objectsMap.get(key)!.timestamp - currentTime)) {
          objectsMap.set(key, {
            id: obj.id,
            text: obj.name,
            type: 'object',
            x: obj.x,
            y: obj.y,
            width: obj.width,
            height: obj.height,
            timestamp: frame.timestamp,
            confidence: obj.confidence,
          });
        }
      }

      // Logos - group by name
      for (const logo of frame.logos || []) {
        const key = logo.name.toLowerCase().trim();
        if (!logosMap.has(key) || Math.abs(frame.timestamp - currentTime) < Math.abs(logosMap.get(key)!.timestamp - currentTime)) {
          logosMap.set(key, {
            id: logo.id,
            text: logo.name,
            type: 'logo',
            x: logo.x,
            y: logo.y,
            width: logo.width,
            height: logo.height,
            timestamp: frame.timestamp,
            confidence: logo.confidence,
          });
        }
      }
    }

    return {
      texts: Array.from(textsMap.values()).sort((a, b) => a.text.localeCompare(b.text)),
      objects: Array.from(objectsMap.values()).sort((a, b) => a.text.localeCompare(b.text)),
      logos: Array.from(logosMap.values()).sort((a, b) => a.text.localeCompare(b.text)),
    };
  }, [analysis, currentTime]);

  // Handle adding/updating a replacement
  const handleReplacementChange = useCallback((item: DetectedItemWithReplacement, newText: string) => {
    setReplacements(prev => ({ ...prev, [item.id]: newText }));

    // Check if there's already a selection for this item
    const existingSelection = selections.find(s => s.label === item.text);

    if (existingSelection) {
      // Update existing selection
      onUpdateSelection(existingSelection.id, {
        replacementType: 'text',
        replacementValue: newText,
      });
    } else if (newText.trim()) {
      // Create new selection
      onAddSelection({
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        startTime: 0,
        endTime: 9999, // Entire video
        type: 'detected',
        label: item.text,
        replacementType: 'text',
        replacementValue: newText,
      });
    }
  }, [selections, onUpdateSelection, onAddSelection]);

  // Handle removing a replacement
  const handleRemoveReplacement = useCallback((item: DetectedItemWithReplacement) => {
    setReplacements(prev => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    const existingSelection = selections.find(s => s.label === item.text);
    if (existingSelection) {
      onDeleteSelection(existingSelection.id);
    }
  }, [selections, onDeleteSelection]);

  // Get replacement value for an item
  const getReplacementValue = useCallback((item: DetectedItemWithReplacement) => {
    const existingSelection = selections.find(s => s.label === item.text);
    if (existingSelection?.replacementValue) {
      return existingSelection.replacementValue;
    }
    return replacements[item.id] || '';
  }, [selections, replacements]);

  // Check if item has a replacement
  const hasReplacement = useCallback((item: DetectedItemWithReplacement) => {
    const existingSelection = selections.find(s => s.label === item.text);
    return !!(existingSelection?.replacementValue || replacements[item.id]);
  }, [selections, replacements]);

  const renderItem = (item: DetectedItemWithReplacement, index: number) => {
    const isHighlighted = highlightedId === item.id;
    const hasRepl = hasReplacement(item);
    const replValue = getReplacementValue(item);

    return (
      <div
        key={item.id}
        ref={(el) => { itemRefs.current[item.id] = el; }}
        className={`p-3 rounded-lg border transition-all cursor-pointer ${
          isHighlighted
            ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
            : hasRepl
            ? 'border-green-500/50 bg-green-500/5 hover:border-green-500'
            : 'border-border bg-card hover:border-primary/50'
        }`}
        onClick={() => onHighlight(isHighlighted ? null : item.id)}
        onMouseEnter={() => !highlightedId && onHighlight(item.id)}
        onMouseLeave={() => !highlightedId && onHighlight(null)}
      >
        <div className="flex items-start gap-3">
          {/* Index number */}
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
            hasRepl ? 'bg-green-500 text-white' : 'bg-secondary text-muted'
          }`}>
            {hasRepl ? '✓' : index + 1}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Original text */}
            <div className="flex items-center gap-2 mb-2">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                item.type === 'text' ? 'bg-blue-500/20 text-blue-400' :
                item.type === 'logo' ? 'bg-purple-500/20 text-purple-400' :
                'bg-yellow-500/20 text-yellow-400'
              }`}>
                {item.type}
              </span>
              <span className="text-sm font-medium text-foreground truncate">
                {item.text}
              </span>
            </div>

            {/* Replacement input */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted whitespace-nowrap">Replace with:</span>
              <input
                type="text"
                value={replValue}
                onChange={(e) => handleReplacementChange(item, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={() => onHighlight(item.id)}
                placeholder="Enter new text..."
                className="flex-1 bg-secondary rounded px-2 py-1 text-sm outline-none focus:ring-2 ring-primary min-w-0"
              />
              {hasRepl && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveReplacement(item);
                  }}
                  className="p-1 rounded hover:bg-danger/20 text-danger transition-colors"
                  title="Remove replacement"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const textCount = allDetectedItems.texts.length;
  const objectCount = allDetectedItems.objects.length + allDetectedItems.logos.length;
  const selectionCount = selections.length;

  return (
    <div className="w-80 bg-card border-l border-border flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Detected Elements</h3>
          <button
            onClick={() => analyzeVideo()}
            disabled={isAnalyzing || !videoId}
            className="px-3 py-1.5 bg-primary text-white rounded text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {isAnalyzing ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Analyzing...
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {analysis ? 'Re-scan' : 'Scan Video'}
              </>
            )}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-secondary rounded-lg p-1">
          <button
            onClick={() => setActiveTab('text')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'text' ? 'bg-card text-foreground shadow' : 'text-muted hover:text-foreground'
            }`}
          >
            Text ({textCount})
          </button>
          <button
            onClick={() => setActiveTab('objects')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'objects' ? 'bg-card text-foreground shadow' : 'text-muted hover:text-foreground'
            }`}
          >
            Objects ({objectCount})
          </button>
          <button
            onClick={() => setActiveTab('selections')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'selections' ? 'bg-card text-foreground shadow' : 'text-muted hover:text-foreground'
            }`}
          >
            Active ({selectionCount})
          </button>
        </div>
      </div>

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4">
        {!analysis && !isAnalyzing && (
          <div className="text-center py-8 text-muted">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p className="text-sm">Click "Scan Video" to detect text and objects</p>
          </div>
        )}

        {isAnalyzing && (
          <div className="text-center py-8 text-muted">
            <svg className="w-12 h-12 mx-auto mb-3 animate-spin opacity-50" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-sm">Analyzing video frames...</p>
          </div>
        )}

        {analysis && !isAnalyzing && (
          <div className="space-y-3">
            {activeTab === 'text' && (
              <>
                {allDetectedItems.texts.length === 0 ? (
                  <p className="text-sm text-muted text-center py-4">No text detected</p>
                ) : (
                  allDetectedItems.texts.map((item, i) => renderItem(item, i))
                )}
              </>
            )}

            {activeTab === 'objects' && (
              <>
                {allDetectedItems.objects.length === 0 && allDetectedItems.logos.length === 0 ? (
                  <p className="text-sm text-muted text-center py-4">No objects detected</p>
                ) : (
                  <>
                    {allDetectedItems.logos.map((item, i) => renderItem(item, i))}
                    {allDetectedItems.objects.map((item, i) => renderItem(item, i + allDetectedItems.logos.length))}
                  </>
                )}
              </>
            )}

            {activeTab === 'selections' && (
              <>
                {selections.length === 0 ? (
                  <p className="text-sm text-muted text-center py-4">No active replacements</p>
                ) : (
                  selections.map((selection, i) => (
                    <div
                      key={selection.id}
                      className={`p-3 rounded-lg border transition-all ${
                        highlightedId === selection.id
                          ? 'border-primary bg-primary/10'
                          : 'border-green-500/50 bg-green-500/5'
                      }`}
                      onMouseEnter={() => onHighlight(selection.id)}
                      onMouseLeave={() => onHighlight(null)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium bg-green-500 text-white">
                          ✓
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-foreground truncate">
                              {selection.label || 'Manual selection'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted mb-2">
                            <span>{selection.startTime.toFixed(1)}s - {selection.endTime.toFixed(1)}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-green-400">→</span>
                            <span className="text-sm text-green-400 truncate">
                              {selection.replacementValue || selection.replacementType}
                            </span>
                            <button
                              onClick={() => onDeleteSelection(selection.id)}
                              className="ml-auto p-1 rounded hover:bg-danger/20 text-danger transition-colors"
                              title="Remove"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Summary footer */}
      {selections.length > 0 && (
        <div className="p-4 border-t border-border bg-green-500/5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">{selections.length} replacement{selections.length !== 1 ? 's' : ''} ready</span>
            <span className="text-green-400 font-medium">Ready to render</span>
          </div>
        </div>
      )}
    </div>
  );
}
