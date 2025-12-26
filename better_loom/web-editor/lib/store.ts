/**
 * Zustand store for Soron video editor state
 */

import { create } from 'zustand';
import { api, type Transcript, type TranscriptWord, type VoiceCloneResponse, type PersonalizationJob, type AnalysisResponse } from './api';

// Extended Voice type with voiceId for UI compatibility
interface Voice {
  id?: string;
  voice_id?: string;
  voiceId?: string; // For UI compatibility
  name: string;
  description?: string;
  status?: string;
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
  replacementType?: 'text' | 'image' | 'blur' | 'remove';
  replacementValue?: string;
  enableTracking?: boolean;
}

export interface TranscriptEdit {
  id: string;
  wordIds: string[];
  originalText: string;
  newText: string;
  startTime: number;
  endTime: number;
  status: 'pending' | 'generating' | 'complete' | 'error';
  generatedAudioUrl?: string;
}

// Deletion edit - marks a time range for removal
export interface DeletionEdit {
  id: string;
  startTime: number;
  endTime: number;
  reason: 'manual' | 'filler' | 'silence';
  wordIds?: string[];  // For word-based deletions
  text?: string;       // What was deleted (for UI display)
}

// Detected filler/silence item from backend
export interface DetectedFiller {
  id: string;
  type: 'filler' | 'silence';
  text: string;
  start: number;
  end: number;
}

// Timeline segment for split/reorder editing
export interface TimelineSegment {
  id: string;
  originalStart: number;  // Start time in original video
  originalEnd: number;    // End time in original video
  trimStart: number;      // Trim offset from start (0 = no trim)
  trimEnd: number;        // Trim offset from end (0 = no trim)
  outputStart: number;    // Position on output timeline (for dragging/gaps)
  order: number;          // Display order (for reordering)
  isDeleted: boolean;     // Soft delete
}

interface EditorState {
  // Video state
  videoUrl: string | null;
  videoId: string | null;
  projectName: string;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  trimStart: number;
  trimEnd: number;

  // Transcript state
  transcript: Transcript | null;
  transcriptEdits: TranscriptEdit[];
  isTranscribing: boolean;
  transcribeError: string | null;

  // Deletion state (non-destructive editing)
  deletions: DeletionEdit[];
  detectedFillers: DetectedFiller[];
  isDetectingFillers: boolean;

  // Timeline segments (for split/reorder editing)
  segments: TimelineSegment[];

  // Visual selection state
  visualSelections: VisualSelection[];
  selectedSelectionId: string | null;
  selectionMode: 'none' | 'visual' | 'transcript';

  // Voice cloning state
  voices: Voice[];
  selectedVoiceId: string | null;
  isCloning: boolean;
  cloneError: string | null;

  // Vision analysis state
  analysis: AnalysisResponse | null;
  isAnalyzing: boolean;
  analyzeError: string | null;

  // Personalization state
  currentJob: PersonalizationJob | null;
  jobProgress: number;

  // Actions
  setVideo: (url: string, id?: string, name?: string) => void;
  setProjectName: (name: string) => void;
  setDuration: (duration: number) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setTrimRange: (start: number, end: number) => void;

  // Transcript actions
  transcribeVideo: () => Promise<void>;
  setTranscript: (transcript: Transcript | null) => void;
  addTranscriptEdit: (edit: Omit<TranscriptEdit, 'id' | 'status'>) => string;
  updateTranscriptEdit: (id: string, updates: Partial<TranscriptEdit>) => void;
  removeTranscriptEdit: (id: string) => void;
  generateEditedAudio: (editId: string) => Promise<void>;

  // Deletion actions (non-destructive editing)
  addDeletion: (deletion: Omit<DeletionEdit, 'id'>) => string;
  removeDeletion: (id: string) => void;
  clearDeletions: () => void;
  detectFillers: () => Promise<void>;
  applyFillerDeletions: (fillerIds: string[]) => void;
  clearDetectedFillers: () => void;

  // Segment actions (split/reorder/trim)
  initializeSegments: (duration: number) => void;
  splitAtTime: (time: number) => void;
  deleteSegment: (segmentId: string) => void;
  restoreSegment: (segmentId: string) => void;
  reorderSegments: (segmentId: string, newOrder: number) => void;
  trimSegment: (segmentId: string, trimStart: number, trimEnd: number) => void;
  moveSegment: (segmentId: string, newOutputStart: number) => void;
  getOrderedSegments: () => TimelineSegment[];

  // Visual selection actions
  addVisualSelection: (selection: Omit<VisualSelection, 'id'>) => string;
  updateVisualSelection: (id: string, updates: Partial<VisualSelection>) => void;
  removeVisualSelection: (id: string) => void;
  setSelectedSelectionId: (id: string | null) => void;
  setSelectionMode: (mode: 'none' | 'visual' | 'transcript') => void;

  // Voice cloning actions
  cloneVoice: (name: string) => Promise<void>;
  loadVoices: () => Promise<void>;
  setSelectedVoiceId: (id: string | null) => void;

  // Vision analysis actions
  analyzeVideo: () => Promise<void>;
  setAnalysis: (analysis: AnalysisResponse | null) => void;

  // Personalization actions
  startPersonalization: () => Promise<void>;
  resetJob: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  // Initial state
  videoUrl: null,
  videoId: null,
  projectName: 'Untitled Project',
  duration: 0,
  currentTime: 0,
  isPlaying: false,
  trimStart: 0,
  trimEnd: 0,

  transcript: null,
  transcriptEdits: [],
  isTranscribing: false,
  transcribeError: null,

  deletions: [],
  detectedFillers: [],
  isDetectingFillers: false,

  segments: [],

  visualSelections: [],
  selectedSelectionId: null,
  selectionMode: 'none',

  voices: [],
  selectedVoiceId: null,
  isCloning: false,
  cloneError: null,

  analysis: null,
  isAnalyzing: false,
  analyzeError: null,

  currentJob: null,
  jobProgress: 0,

  // Video actions
  setVideo: (url, id, name) => {
    set({
      videoUrl: url,
      videoId: id || null,
      projectName: name || 'Untitled Project',
      currentTime: 0,
      isPlaying: false,
      trimStart: 0,
      transcript: null,
      transcriptEdits: [],
      deletions: [],
      detectedFillers: [],
      visualSelections: [],
      analysis: null,
    });

    // Auto-load transcript and analysis if video has ID (was uploaded to backend)
    // Uses exponential backoff with longer timeout for transcription (can take 30-60s)
    if (id) {
      // Load transcript with exponential backoff (may still be processing)
      const loadTranscript = async (retries = 12) => {
        let delay = 1000; // Start at 1s
        for (let i = 0; i < retries; i++) {
          try {
            const transcript = await api.getTranscript(id);
            if (transcript) {
              console.log('[Transcript] Loaded successfully');
              set({ transcript });
              return;
            }
          } catch {}
          // Exponential backoff: 1s → 2s → 4s → 5s → 5s... (cap at 5s)
          // Total: ~60s of retry time
          if (i < retries - 1) {
            console.log(`[Transcript] Not ready, retrying in ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 1.5, 5000); // Increase by 50%, cap at 5s
          }
        }
        console.log('[Transcript] Failed to load after retries');
      };
      loadTranscript();

      // Load analysis with exponential backoff (runs in parallel with transcript)
      const loadAnalysis = async (retries = 12) => {
        let delay = 1000;
        for (let i = 0; i < retries; i++) {
          try {
            const analysis = await api.getAnalysis(id);
            if (analysis) {
              console.log('[Analysis] Loaded successfully');
              set({ analysis });
              return;
            }
          } catch {}
          if (i < retries - 1) {
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 1.5, 5000);
          }
        }
      };
      loadAnalysis();
    }
  },

  setProjectName: (name) => set({ projectName: name }),
  setDuration: (duration) => set({ duration, trimEnd: duration }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setTrimRange: (start, end) => set({ trimStart: start, trimEnd: end }),

  // Transcript actions - Uses REAL Google Chirp 3 API
  transcribeVideo: async () => {
    const { videoId } = get();
    if (!videoId) {
      set({
        isTranscribing: false,
        transcribeError: 'Video must be uploaded to server first. No mock data - real API only.',
      });
      return;
    }

    try {
      set({ isTranscribing: true, transcribeError: null });
      const transcript = await api.transcribeVideo(videoId);
      set({ transcript, isTranscribing: false });
    } catch (error) {
      set({
        isTranscribing: false,
        transcribeError: error instanceof Error ? error.message : 'Transcription failed',
      });
    }
  },

  setTranscript: (transcript) => set({ transcript }),

  addTranscriptEdit: (edit) => {
    const id = `edit-${Date.now()}`;
    set(state => ({
      transcriptEdits: [...state.transcriptEdits, { ...edit, id, status: 'pending' as const }],
    }));
    return id;
  },

  updateTranscriptEdit: (id, updates) => set(state => ({
    transcriptEdits: state.transcriptEdits.map(e =>
      e.id === id ? { ...e, ...updates } : e
    ),
  })),

  removeTranscriptEdit: (id) => set(state => ({
    transcriptEdits: state.transcriptEdits.filter(e => e.id !== id),
  })),

  generateEditedAudio: async (editId) => {
    const { transcriptEdits, selectedVoiceId } = get();
    const edit = transcriptEdits.find(e => e.id === editId);
    if (!edit || !selectedVoiceId) return;

    try {
      set(state => ({
        transcriptEdits: state.transcriptEdits.map(e =>
          e.id === editId ? { ...e, status: 'generating' as const } : e
        ),
      }));

      const duration = edit.endTime - edit.startTime;
      const result = await api.generateSpeech(edit.newText, selectedVoiceId, duration);

      set(state => ({
        transcriptEdits: state.transcriptEdits.map(e =>
          e.id === editId ? { ...e, status: 'complete' as const, generatedAudioUrl: result.audioUrl } : e
        ),
      }));
    } catch (error) {
      set(state => ({
        transcriptEdits: state.transcriptEdits.map(e =>
          e.id === editId ? { ...e, status: 'error' as const } : e
        ),
      }));
    }
  },

  // Deletion actions (non-destructive editing)
  addDeletion: (deletion) => {
    const id = `deletion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    set(state => ({
      deletions: [...state.deletions, { ...deletion, id }].sort((a, b) => a.startTime - b.startTime),
    }));
    return id;
  },

  removeDeletion: (id) => set(state => ({
    deletions: state.deletions.filter(d => d.id !== id),
  })),

  clearDeletions: () => set({ deletions: [] }),

  detectFillers: async () => {
    const { videoId } = get();
    if (!videoId) return;

    set({ isDetectingFillers: true });
    try {
      const result = await api.detectFillers(videoId);
      set({ detectedFillers: result.fillers, isDetectingFillers: false });
    } catch (error) {
      console.error('Filler detection failed:', error);
      set({ isDetectingFillers: false });
    }
  },

  applyFillerDeletions: (fillerIds) => {
    const { detectedFillers, deletions } = get();
    const fillersToDelete = detectedFillers.filter(f => fillerIds.includes(f.id));

    const newDeletions = fillersToDelete.map(f => ({
      id: `deletion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      startTime: f.start,
      endTime: f.end,
      reason: f.type as 'filler' | 'silence',
      text: f.text,
    }));

    set({
      deletions: [...deletions, ...newDeletions].sort((a, b) => a.startTime - b.startTime),
      detectedFillers: [],
    });
  },

  clearDetectedFillers: () => set({ detectedFillers: [] }),

  // Segment actions (split/reorder/trim)
  initializeSegments: (duration: number) => {
    // Create single segment spanning entire video
    if (duration > 0) {
      set({
        segments: [{
          id: `seg-${Date.now()}`,
          originalStart: 0,
          originalEnd: duration,
          trimStart: 0,
          trimEnd: 0,
          outputStart: 0,  // Starts at beginning of output timeline
          order: 0,
          isDeleted: false,
        }],
      });
    }
  },

  splitAtTime: (time: number) => {
    const { segments, duration } = get();
    console.log('[Store] splitAtTime called:', { time, duration, segmentsCount: segments.length });

    if (time <= 0.1 || time >= duration - 0.1) {
      console.log('[Store] Split rejected: time too close to edges');
      return;
    }

    // Find the segment that contains this time
    const segmentIndex = segments.findIndex(seg => {
      const effectiveStart = seg.originalStart + seg.trimStart;
      const effectiveEnd = seg.originalEnd - seg.trimEnd;
      const contains = !seg.isDeleted && time >= effectiveStart && time <= effectiveEnd;
      console.log('[Store] Checking segment:', {
        id: seg.id,
        effectiveStart,
        effectiveEnd,
        time,
        contains,
        isDeleted: seg.isDeleted
      });
      return contains;
    });

    console.log('[Store] Found segment index:', segmentIndex);
    if (segmentIndex === -1) return;

    const segment = segments[segmentIndex];
    const newSegments = [...segments];

    // Create two new segments from the split
    // Calculate where this segment was on the output timeline
    const segmentOutputStart = segment.outputStart || 0;
    const leftDuration = time - segment.originalStart - segment.trimStart;

    const leftSegment: TimelineSegment = {
      id: `seg-${Date.now()}-l`,
      originalStart: segment.originalStart,
      originalEnd: time,
      trimStart: segment.trimStart,
      trimEnd: 0,
      outputStart: segmentOutputStart,
      order: segment.order,
      isDeleted: false,
    };

    const rightSegment: TimelineSegment = {
      id: `seg-${Date.now()}-r`,
      originalStart: time,
      originalEnd: segment.originalEnd,
      trimStart: 0,
      trimEnd: segment.trimEnd,
      outputStart: segmentOutputStart + leftDuration,  // Right after left segment
      order: segment.order + 0.5, // Will be renumbered
      isDeleted: false,
    };

    // Replace the original segment with two new ones
    newSegments.splice(segmentIndex, 1, leftSegment, rightSegment);

    // Renumber orders
    const sortedSegments = newSegments
      .sort((a, b) => a.order - b.order)
      .map((seg, i) => ({ ...seg, order: i }));

    set({ segments: sortedSegments });
  },

  deleteSegment: (segmentId: string) => {
    set(state => ({
      segments: state.segments.map(seg =>
        seg.id === segmentId ? { ...seg, isDeleted: true } : seg
      ),
    }));
  },

  restoreSegment: (segmentId: string) => {
    set(state => ({
      segments: state.segments.map(seg =>
        seg.id === segmentId ? { ...seg, isDeleted: false } : seg
      ),
    }));
  },

  reorderSegments: (segmentId: string, newOrder: number) => {
    const { segments } = get();
    const segmentIndex = segments.findIndex(s => s.id === segmentId);
    if (segmentIndex === -1) return;

    const segment = segments[segmentIndex];
    const otherSegments = segments.filter(s => s.id !== segmentId);

    // Insert at new position
    const reordered = [
      ...otherSegments.slice(0, newOrder),
      segment,
      ...otherSegments.slice(newOrder),
    ].map((seg, i) => ({ ...seg, order: i }));

    set({ segments: reordered });
  },

  trimSegment: (segmentId: string, trimStart: number, trimEnd: number) => {
    set(state => ({
      segments: state.segments.map(seg =>
        seg.id === segmentId
          ? { ...seg, trimStart: Math.max(0, trimStart), trimEnd: Math.max(0, trimEnd) }
          : seg
      ),
    }));
  },

  moveSegment: (segmentId: string, newOutputStart: number) => {
    set(state => ({
      segments: state.segments.map(seg =>
        seg.id === segmentId
          ? { ...seg, outputStart: Math.max(0, newOutputStart) }
          : seg
      ),
    }));
  },

  getOrderedSegments: () => {
    const { segments } = get();
    return segments
      .filter(s => !s.isDeleted)
      .sort((a, b) => a.order - b.order);
  },

  // Visual selection actions
  addVisualSelection: (selection) => {
    const id = `selection-${Date.now()}`;
    set(state => ({
      visualSelections: [...state.visualSelections, { ...selection, id }],
    }));
    return id;
  },

  updateVisualSelection: (id, updates) => set(state => ({
    visualSelections: state.visualSelections.map(s =>
      s.id === id ? { ...s, ...updates } : s
    ),
  })),

  removeVisualSelection: (id) => set(state => ({
    visualSelections: state.visualSelections.filter(s => s.id !== id),
    selectedSelectionId: state.selectedSelectionId === id ? null : state.selectedSelectionId,
  })),

  setSelectedSelectionId: (id) => set({ selectedSelectionId: id }),
  setSelectionMode: (mode) => set({ selectionMode: mode }),

  // Voice cloning actions - Uses REAL ElevenLabs API
  cloneVoice: async (name) => {
    const { videoId } = get();
    if (!videoId) {
      set({ cloneError: 'Video must be uploaded first' });
      return;
    }

    try {
      set({ isCloning: true, cloneError: null });
      const voice = await api.cloneVoice(videoId, name);
      set(state => ({
        voices: [...state.voices, { id: voice.voice_id, name: voice.name }],
        selectedVoiceId: voice.voice_id,
        isCloning: false,
      }));
    } catch (error) {
      set({
        isCloning: false,
        cloneError: error instanceof Error ? error.message : 'Voice cloning failed',
      });
    }
  },

  loadVoices: async () => {
    try {
      const rawVoices = await api.listVoices();
      // Normalize voice IDs for compatibility
      const voices = rawVoices.map(v => ({
        ...v,
        id: v.id || v.voice_id,
        voiceId: v.id || v.voice_id, // For PersonalizationModal compatibility
      }));
      set({ voices });
    } catch {
      // Ignore errors loading voices
    }
  },

  setSelectedVoiceId: (id) => set({ selectedVoiceId: id }),

  // Vision analysis actions - Uses REAL Google Vision API
  analyzeVideo: async () => {
    const { videoId } = get();
    if (!videoId) {
      set({
        isAnalyzing: false,
        analyzeError: 'Video must be uploaded to server first.',
      });
      return;
    }

    try {
      set({ isAnalyzing: true, analyzeError: null });
      const analysis = await api.analyzeVideo(videoId);
      set({ analysis, isAnalyzing: false });
    } catch (error) {
      set({
        isAnalyzing: false,
        analyzeError: error instanceof Error ? error.message : 'Analysis failed',
      });
    }
  },

  setAnalysis: (analysis) => set({ analysis }),

  // Personalization actions
  startPersonalization: async () => {
    const { videoId, transcriptEdits, visualSelections, selectedVoiceId } = get();
    if (!videoId) return;

    try {
      const job = await api.createPersonalizationJob({
        videoId,
        voiceId: selectedVoiceId || undefined,
        transcriptEdits: transcriptEdits.map(e => ({
          segmentId: e.id,
          originalText: e.originalText,
          newText: e.newText,
          startTime: e.startTime,
          endTime: e.endTime,
        })),
        visualReplacements: visualSelections
          .filter(s => s.replacementType && s.replacementValue)
          .map(s => ({
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            startTime: s.startTime,
            endTime: s.endTime,
            replacementType: s.replacementType!,
            replacementValue: s.replacementValue!,
          })),
      });

      set({ currentJob: job });

      // Poll for completion
      await api.pollJobUntilComplete(job.id, (progress) => {
        set({ jobProgress: progress });
      });

      const completedJob = await api.getJobStatus(job.id);
      set({ currentJob: completedJob, jobProgress: 100 });
    } catch (error) {
      set({
        currentJob: {
          id: '',
          status: 'failed',
          progress: 0,
          error: error instanceof Error ? error.message : 'Personalization failed',
        },
      });
    }
  },

  resetJob: () => set({ currentJob: null, jobProgress: 0 }),
}));

// Selector hooks for common state slices
export const useVideoState = () => useEditorStore(state => ({
  videoUrl: state.videoUrl,
  videoId: state.videoId,
  projectName: state.projectName,
  duration: state.duration,
  currentTime: state.currentTime,
  isPlaying: state.isPlaying,
  trimStart: state.trimStart,
  trimEnd: state.trimEnd,
}));

export const useTranscriptState = () => useEditorStore(state => ({
  transcript: state.transcript,
  transcriptEdits: state.transcriptEdits,
  isTranscribing: state.isTranscribing,
  transcribeError: state.transcribeError,
}));

export const useVisualSelectionState = () => useEditorStore(state => ({
  visualSelections: state.visualSelections,
  selectedSelectionId: state.selectedSelectionId,
  selectionMode: state.selectionMode,
}));
