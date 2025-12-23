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
      visualSelections: [],
      analysis: null,
    });

    // Auto-load transcript and analysis if video has ID (was uploaded to backend)
    // Uses exponential backoff: 500ms, 1s, 2s, 4s, 8s = 15.5s total (vs 30s with linear)
    if (id) {
      // Load transcript with exponential backoff (may still be processing)
      const loadTranscript = async (retries = 5) => {
        let delay = 500; // Start at 500ms
        for (let i = 0; i < retries; i++) {
          try {
            const transcript = await api.getTranscript(id);
            if (transcript) {
              set({ transcript });
              return;
            }
          } catch {}
          // Exponential backoff: 500ms → 1s → 2s → 4s → 8s
          if (i < retries - 1) {
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 2, 8000); // Double delay, cap at 8s
          }
        }
      };
      loadTranscript();

      // Load analysis with exponential backoff (runs in parallel with transcript)
      const loadAnalysis = async (retries = 5) => {
        let delay = 500;
        for (let i = 0; i < retries; i++) {
          try {
            const analysis = await api.getAnalysis(id);
            if (analysis) {
              set({ analysis });
              return;
            }
          } catch {}
          if (i < retries - 1) {
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 2, 8000);
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
