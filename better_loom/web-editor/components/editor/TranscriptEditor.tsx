'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { TranscriptWord } from './VideoEditor';
import { useEditorStore } from '@/lib/store';

interface TranscriptEditorProps {
  transcript: TranscriptWord[];
  currentTime: number;
  isTranscribing: boolean;
  transcribeError?: string | null;
  videoId?: string | null;
  onGenerateTranscript: () => void;
  onWordClick: (word: TranscriptWord) => void;
  onEditWord: (wordId: string, newText: string) => void;
}

export function TranscriptEditor({
  transcript,
  currentTime,
  isTranscribing,
  transcribeError,
  videoId,
  onGenerateTranscript,
  onWordClick,
  onEditWord,
}: TranscriptEditorProps) {
  const [selectedWords, setSelectedWords] = useState<Set<string>>(new Set());
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [selectionStart, setSelectionStart] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Voice cloning and TTS state from store
  const {
    selectedVoiceId,
    isCloning,
    cloneError,
    cloneVoice,
    transcriptEdits,
    addTranscriptEdit,
    generateEditedAudio,
    // Deletion state
    deletions,
    addDeletion,
    removeDeletion,
    detectedFillers,
    isDetectingFillers,
    detectFillers,
    applyFillerDeletions,
    clearDetectedFillers,
  } = useEditorStore();

  // Track which words are generating TTS
  const [generatingWords, setGeneratingWords] = useState<Set<string>>(new Set());

  // Find current word based on playback time
  const currentWordId = transcript.find(
    w => currentTime >= w.startTime && currentTime < w.endTime
  )?.id;

  // Handle word selection (for multi-word selection)
  const handleWordMouseDown = useCallback((wordId: string, e: React.MouseEvent) => {
    if (e.shiftKey && selectionStart) {
      // Shift-click to extend selection
      const startIdx = transcript.findIndex(w => w.id === selectionStart);
      const endIdx = transcript.findIndex(w => w.id === wordId);

      if (startIdx !== -1 && endIdx !== -1) {
        const newSelection = new Set<string>();
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        for (let i = from; i <= to; i++) {
          newSelection.add(transcript[i].id);
        }
        setSelectedWords(newSelection);
      }
    } else {
      // Single click
      setSelectionStart(wordId);
      if (selectedWords.has(wordId)) {
        const newSelection = new Set(selectedWords);
        newSelection.delete(wordId);
        setSelectedWords(newSelection);
      } else {
        setSelectedWords(new Set([wordId]));
      }
    }
  }, [selectedWords, selectionStart, transcript]);

  const handleWordDoubleClick = useCallback((word: TranscriptWord) => {
    setEditingWord(word.id);
    setEditText(word.editedText || word.text);
  }, []);

  // Auto-clone voice and generate TTS for edited word
  const processEditWithVoice = useCallback(async (wordId: string, newText: string) => {
    const word = transcript.find(w => w.id === wordId);
    if (!word || newText === word.text) return;

    // Update the word text locally
    onEditWord(wordId, newText);

    // If no voice is cloned yet, clone it first
    if (!selectedVoiceId && !isCloning) {
      try {
        await cloneVoice('My Voice');
      } catch (err) {
        console.error('Voice cloning failed:', err);
        return;
      }
    }

    // Create a transcript edit and generate TTS
    setGeneratingWords(prev => new Set(prev).add(wordId));

    const editId = addTranscriptEdit({
      wordIds: [wordId],
      originalText: word.text,
      newText: newText,
      startTime: word.startTime,
      endTime: word.endTime,
    });

    // Generate TTS for the edit (needs voice to be cloned first)
    // Small delay to ensure voice is ready
    setTimeout(async () => {
      try {
        await generateEditedAudio(editId);
      } catch (err) {
        console.error('TTS generation failed:', err);
      } finally {
        setGeneratingWords(prev => {
          const next = new Set(prev);
          next.delete(wordId);
          return next;
        });
      }
    }, selectedVoiceId ? 0 : 2000); // Wait for voice clone if needed
  }, [transcript, onEditWord, selectedVoiceId, isCloning, cloneVoice, addTranscriptEdit, generateEditedAudio]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent, wordId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      processEditWithVoice(wordId, editText);
      setEditingWord(null);
      setEditText('');
    } else if (e.key === 'Escape') {
      setEditingWord(null);
      setEditText('');
    }
  }, [editText, processEditWithVoice]);

  const handleEditBlur = useCallback((wordId: string) => {
    if (editText.trim()) {
      processEditWithVoice(wordId, editText);
    }
    setEditingWord(null);
    setEditText('');
  }, [editText, processEditWithVoice]);

  const clearSelection = useCallback(() => {
    setSelectedWords(new Set());
    setSelectionStart(null);
  }, []);

  // Helper to check if a word is deleted
  const isWordDeleted = useCallback((word: TranscriptWord) => {
    return deletions.some(d =>
      word.startTime >= d.startTime && word.endTime <= d.endTime
    );
  }, [deletions]);

  // Helper to get deletion for a word (to show restore option)
  const getDeletionForWord = useCallback((word: TranscriptWord) => {
    return deletions.find(d =>
      word.startTime >= d.startTime && word.endTime <= d.endTime
    );
  }, [deletions]);

  // Delete selected words
  const deleteSelectedWords = useCallback(() => {
    if (selectedWords.size === 0) return;

    const wordsToDelete = transcript.filter(w => selectedWords.has(w.id));
    if (wordsToDelete.length === 0) return;

    // Sort by start time
    const sortedWords = [...wordsToDelete].sort((a, b) => a.startTime - b.startTime);

    // Group contiguous words into single deletions
    const groups: TranscriptWord[][] = [];
    let currentGroup: TranscriptWord[] = [];

    for (const word of sortedWords) {
      if (currentGroup.length === 0) {
        currentGroup.push(word);
      } else {
        const lastWord = currentGroup[currentGroup.length - 1];
        // Check if words are contiguous (within 0.3s gap)
        if (word.startTime - lastWord.endTime < 0.3) {
          currentGroup.push(word);
        } else {
          groups.push(currentGroup);
          currentGroup = [word];
        }
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Create deletion for each group
    for (const group of groups) {
      addDeletion({
        startTime: group[0].startTime,
        endTime: group[group.length - 1].endTime,
        reason: 'manual',
        wordIds: group.map(w => w.id),
        text: group.map(w => w.text).join(' '),
      });
    }

    setSelectedWords(new Set());
  }, [selectedWords, transcript, addDeletion]);

  // Keyboard handler for Delete/Backspace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if editing a word or in an input
      if (editingWord || (e.target as HTMLElement)?.tagName === 'INPUT') return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWords.size > 0) {
        e.preventDefault();
        deleteSelectedWords();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedWords, editingWord, deleteSelectedWords]);

  const handleReplaceSelected = useCallback(() => {
    if (selectedWords.size === 0) return;
    // This would open a modal to enter replacement text
    // For now, we'll just edit the first selected word
    const firstSelected = Array.from(selectedWords)[0];
    const word = transcript.find(w => w.id === firstSelected);
    if (word) {
      handleWordDoubleClick(word);
    }
  }, [selectedWords, transcript, handleWordDoubleClick]);

  // Auto-scroll to current word
  useEffect(() => {
    if (currentWordId && containerRef.current) {
      const wordElement = containerRef.current.querySelector(`[data-word-id="${currentWordId}"]`);
      if (wordElement) {
        wordElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentWordId]);

  if (transcript.length === 0) {
    return (
      <div className="bg-card border-t border-border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <div>
              <span className="text-muted text-sm">
                {videoId ? 'No transcript available' : 'Video must be uploaded to server first'}
              </span>
              {transcribeError && (
                <p className="text-red-500 text-xs mt-1">{transcribeError}</p>
              )}
              {videoId && (
                <p className="text-xs text-primary mt-1">Using Google Chirp 3 (Real API)</p>
              )}
            </div>
          </div>
          <button
            onClick={onGenerateTranscript}
            disabled={isTranscribing || !videoId}
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isTranscribing ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Transcribing with Chirp 3...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Generate Transcript
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card border-t border-border">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-medium">Transcript</span>
          {selectedWords.size > 0 && (
            <span className="text-xs text-muted bg-secondary px-2 py-1 rounded">
              {selectedWords.size} word{selectedWords.size !== 1 ? 's' : ''} selected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Clean Up button - detects and removes fillers/silence */}
          <button
            onClick={() => {
              if (detectedFillers.length > 0) {
                // Apply all detected fillers as deletions
                applyFillerDeletions(detectedFillers.map(f => f.id));
              } else {
                // Detect fillers first
                detectFillers();
              }
            }}
            disabled={isDetectingFillers || !videoId}
            className="px-3 py-1.5 bg-orange-500 text-white rounded text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            title="Remove filler words (um, uh) and long silences"
          >
            {isDetectingFillers ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Detecting...
              </>
            ) : detectedFillers.length > 0 ? (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Remove {detectedFillers.length} Items
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Clean Up
              </>
            )}
          </button>

          {/* Cancel detected fillers */}
          {detectedFillers.length > 0 && (
            <button
              onClick={clearDetectedFillers}
              className="px-2 py-1.5 text-muted hover:text-foreground text-sm transition-colors"
              title="Cancel"
            >
              ✕
            </button>
          )}

          {selectedWords.size > 0 && (
            <>
              <button
                onClick={deleteSelectedWords}
                className="px-3 py-1.5 bg-red-500 text-white rounded text-sm font-medium hover:bg-red-600 transition-colors flex items-center gap-1"
                title="Delete selected words (or press Delete key)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete
              </button>
              <button
                onClick={handleReplaceSelected}
                className="px-3 py-1.5 bg-accent text-white rounded text-sm font-medium hover:opacity-90 transition-opacity flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Replace
              </button>
              <button
                onClick={clearSelection}
                className="px-2 py-1.5 text-muted hover:text-foreground text-sm transition-colors"
              >
                Clear
              </button>
            </>
          )}
          <span className="text-xs text-muted">
            {deletions.length > 0
              ? `${deletions.length} cut${deletions.length !== 1 ? 's' : ''} • `
              : ''}
            Select words → Delete
          </span>
        </div>
      </div>

      {/* Transcript content */}
      <div ref={containerRef} className="p-4 max-h-32 overflow-y-auto">
        <div className="flex flex-wrap gap-1">
          {transcript.map((word) => {
            const isActive = word.id === currentWordId;
            const isSelected = selectedWords.has(word.id);
            const isEditing = editingWord === word.id;

            if (isEditing) {
              return (
                <input
                  key={word.id}
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => handleEditKeyDown(e, word.id)}
                  onBlur={() => handleEditBlur(word.id)}
                  className="bg-accent/30 border border-accent rounded px-2 py-1 text-sm outline-none min-w-[60px]"
                  autoFocus
                />
              );
            }

            const isGenerating = generatingWords.has(word.id);
            const editStatus = transcriptEdits.find(e => e.wordIds.includes(word.id));
            const isDeleted = isWordDeleted(word);
            const deletion = getDeletionForWord(word);

            return (
              <span
                key={word.id}
                data-word-id={word.id}
                onClick={() => {
                  if (isDeleted && deletion) {
                    // Click on deleted word to restore it
                    removeDeletion(deletion.id);
                  } else {
                    onWordClick(word);
                  }
                }}
                onMouseDown={(e) => !isDeleted && handleWordMouseDown(word.id, e)}
                onDoubleClick={() => !isDeleted && handleWordDoubleClick(word)}
                className={`transcript-word ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${word.isEdited ? 'editable' : ''} ${isGenerating ? 'generating' : ''} ${editStatus?.status === 'complete' ? 'tts-ready' : ''} ${isDeleted ? 'deleted' : ''}`}
                title={isDeleted ? 'Click to restore' : isGenerating ? 'Generating AI voice...' : editStatus?.status === 'complete' ? 'AI voice ready' : undefined}
                style={isDeleted ? { textDecoration: 'line-through', opacity: 0.5, background: 'rgba(239, 68, 68, 0.1)' } : undefined}
              >
                {word.editedText || word.text}
                {isGenerating && (
                  <span className="ml-1 inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                )}
                {editStatus?.status === 'complete' && (
                  <svg className="ml-1 inline-block w-3 h-3 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Voice cloning status */}
      {isCloning && (
        <div className="px-4 py-2 border-t border-border bg-primary/10">
          <div className="flex items-center gap-2 text-xs text-primary">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Cloning your voice from the video...
          </div>
        </div>
      )}

      {cloneError && (
        <div className="px-4 py-2 border-t border-border bg-red-500/10">
          <span className="text-xs text-red-500">{cloneError}</span>
        </div>
      )}

      {/* Edited words indicator */}
      {transcript.some(w => w.isEdited) && (
        <div className="px-4 py-2 border-t border-border bg-accent/10">
          <div className="flex items-center justify-between">
            <span className="text-xs text-accent flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {transcript.filter(w => w.isEdited).length} word{transcript.filter(w => w.isEdited).length !== 1 ? 's' : ''} edited
              {selectedVoiceId ? ' - AI voice auto-generating' : ' - Voice will clone on first edit'}
            </span>
            <div className="flex items-center gap-2 text-xs">
              {transcriptEdits.filter(e => e.status === 'complete').length > 0 && (
                <span className="text-green-500 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  {transcriptEdits.filter(e => e.status === 'complete').length} ready
                </span>
              )}
              {transcriptEdits.filter(e => e.status === 'generating').length > 0 && (
                <span className="text-primary flex items-center gap-1">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  {transcriptEdits.filter(e => e.status === 'generating').length} generating
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
