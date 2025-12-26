/**
 * API service layer for Soron video editor
 * Connects to the FastAPI backend for transcription, voice cloning, and lip-sync
 *
 * PRODUCTION API - Real services (Chirp 3, Vision, ElevenLabs, Sync Labs)
 */

// Use environment variable or default to localhost:8000 for development
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api';

export interface TranscriptWord {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  words: TranscriptWord[];
  speaker?: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  duration: number;
  language: string;
}

export interface VideoUploadResponse {
  video_id: string;
  filename?: string;
  url: string;
  duration: number;
  width: number;
  height: number;
}

export interface DetectedObject {
  id: string;
  name: string;
  confidence: number;
  /** X position as percentage (0-100) of frame width */
  x: number;
  /** Y position as percentage (0-100) of frame height */
  y: number;
  /** Width as percentage (0-100) of frame width */
  width: number;
  /** Height as percentage (0-100) of frame height */
  height: number;
  timestamp: number;
}

export interface DetectedText {
  id: string;
  text: string;
  confidence: number;
  /** X position as percentage (0-100) of frame width */
  x: number;
  /** Y position as percentage (0-100) of frame height */
  y: number;
  /** Width as percentage (0-100) of frame width */
  width: number;
  /** Height as percentage (0-100) of frame height */
  height: number;
  timestamp: number;
}

export interface FrameAnalysis {
  timestamp: number;
  objects: DetectedObject[];
  texts: DetectedText[];
  logos: DetectedObject[];
}

export interface AnalysisResponse {
  frames: FrameAnalysis[];
  unique_objects: string[];
  unique_texts: string[];
}

export interface VoiceCloneResponse {
  voice_id: string;
  voiceId?: string; // alias for compatibility
  name: string;
  method?: 'PVC' | 'IVC';  // Professional or Instant voice clone
  status: 'pending' | 'processing' | 'ready' | 'failed';
}

export interface Voice {
  id?: string;
  voice_id?: string;
  name: string;
  description?: string;
}

export interface PersonalizationJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  outputUrl?: string;
  error?: string;
}

export interface PersonalizationRequest {
  videoId: string;
  voiceId?: string;
  transcriptEdits?: Array<{
    segmentId: string;
    originalText: string;
    newText: string;
    startTime: number;
    endTime: number;
  }>;
  visualReplacements?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    startTime: number;
    endTime: number;
    replacementType: 'text' | 'image' | 'blur' | 'remove';
    replacementValue: string;
  }>;
}

class ApiService {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }));
      throw new Error(error.detail || error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // Health check
  async healthCheck(): Promise<{ status: string; version: string }> {
    const response = await fetch(`${API_BASE.replace('/api', '')}/health`);
    return response.json();
  }

  // Test all services
  async testServices(): Promise<Record<string, string>> {
    return this.request<Record<string, string>>('/test/services');
  }

  // ========== Video Operations ==========

  async uploadVideo(file: File): Promise<VideoUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/videos/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Upload failed' }));
      throw new Error(error.detail || 'Failed to upload video');
    }

    return response.json();
  }

  async listVideos(): Promise<VideoUploadResponse[]> {
    return this.request<VideoUploadResponse[]>('/videos');
  }

  getVideoStreamUrl(videoId: string): string {
    return `${API_BASE}/videos/${videoId}/stream`;
  }

  // ========== Transcription (Google Chirp 3) ==========

  async transcribeVideo(videoId: string): Promise<Transcript> {
    // Convert server response format to frontend format
    const response = await this.request<{
      segments: Array<{
        text: string;
        start_time: number;
        end_time: number;
        words: Array<{
          id: string;
          text: string;
          start_time: number;
          end_time: number;
          confidence: number;
        }>;
      }>;
      duration: number;
      language: string;
    }>(`/videos/${videoId}/transcribe`, { method: 'POST' });

    // Transform to frontend format (camelCase)
    return {
      segments: response.segments.map((seg, i) => ({
        id: `seg-${i}`,
        text: seg.text,
        startTime: seg.start_time,
        endTime: seg.end_time,
        words: seg.words.map(w => ({
          id: w.id,
          text: w.text,
          startTime: w.start_time,
          endTime: w.end_time,
          confidence: w.confidence,
        })),
      })),
      duration: response.duration,
      language: response.language,
    };
  }

  async getTranscript(videoId: string): Promise<Transcript | null> {
    try {
      const response = await this.request<{
        segments: Array<{
          text: string;
          start_time: number;
          end_time: number;
          words: Array<{
            id: string;
            text: string;
            start_time: number;
            end_time: number;
            confidence: number;
          }>;
        }>;
        duration: number;
        language: string;
      }>(`/videos/${videoId}/transcript`);

      return {
        segments: response.segments.map((seg, i) => ({
          id: `seg-${i}`,
          text: seg.text,
          startTime: seg.start_time,
          endTime: seg.end_time,
          words: seg.words.map(w => ({
            id: w.id,
            text: w.text,
            startTime: w.start_time,
            endTime: w.end_time,
            confidence: w.confidence,
          })),
        })),
        duration: response.duration,
        language: response.language,
      };
    } catch {
      return null;
    }
  }

  // ========== Filler/Silence Detection ==========

  async detectFillers(videoId: string): Promise<{
    fillers: Array<{
      id: string;
      type: 'filler' | 'silence';
      text: string;
      start: number;
      end: number;
    }>;
  }> {
    return this.request<{
      fillers: Array<{
        id: string;
        type: 'filler' | 'silence';
        text: string;
        start: number;
        end: number;
      }>;
    }>(`/videos/${videoId}/detect-fillers`);
  }

  async applyDeletions(videoId: string, deletions: Array<{
    startTime: number;
    endTime: number;
  }>): Promise<{ output_url: string; job_id: string }> {
    return this.request<{ output_url: string; job_id: string }>(
      `/videos/${videoId}/apply-deletions`,
      {
        method: 'POST',
        body: JSON.stringify({ deletions }),
      }
    );
  }

  // ========== Vision Analysis (Google Vision API) ==========

  async analyzeVideo(videoId: string, interval: number = 2.0): Promise<AnalysisResponse> {
    return this.request<AnalysisResponse>(`/videos/${videoId}/analyze?interval=${interval}`, {
      method: 'POST',
    });
  }

  async getAnalysis(videoId: string): Promise<AnalysisResponse | null> {
    try {
      return await this.request<AnalysisResponse>(`/videos/${videoId}/analysis`);
    } catch {
      return null;
    }
  }

  // ========== Voice Services (ElevenLabs) ==========

  async listVoices(): Promise<Voice[]> {
    return this.request<Voice[]>('/voices');
  }

  async cloneVoice(
    videoId: string,
    name: string,
    method: 'pvc' | 'ivc' = 'pvc'  // PVC = Pro (highest quality), IVC = Instant (faster)
  ): Promise<VoiceCloneResponse> {
    const formData = new FormData();
    formData.append('name', name);
    formData.append('method', method);

    const response = await fetch(`${API_BASE}/videos/${videoId}/clone-voice`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Clone failed' }));
      throw new Error(error.detail || 'Failed to clone voice');
    }

    const data = await response.json();
    return {
      voice_id: data.voice_id,
      voiceId: data.voice_id,
      name: data.name,
      method: data.method,  // 'PVC' or 'IVC'
      status: 'ready',
    };
  }

  async generateSpeech(
    text: string,
    voiceId: string,
    targetDuration?: number
  ): Promise<{ audioUrl: string; duration: number }> {
    const formData = new FormData();
    formData.append('text', text);
    formData.append('voice_id', voiceId);
    if (targetDuration) {
      formData.append('target_duration', targetDuration.toString());
    }

    const response = await fetch(`${API_BASE}/voice/generate`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Generation failed' }));
      throw new Error(error.detail || 'Failed to generate speech');
    }

    const data = await response.json();
    return {
      audioUrl: `${API_BASE}${data.audio_url}`,
      duration: data.duration,
    };
  }

  // ========== Templates & Personalization ==========

  async createTemplate(
    videoId: string,
    name: string,
    fields: PersonalizationField[]
  ): Promise<{ id: string; name: string }> {
    const formData = new FormData();
    formData.append('video_id', videoId);
    formData.append('name', name);
    formData.append('fields', JSON.stringify(fields));

    const response = await fetch(`${API_BASE}/templates`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to create template');
    }

    return response.json();
  }

  async getTemplate(templateId: string): Promise<{
    id: string;
    name: string;
    video_id: string;
    voice_id?: string;
    fields: PersonalizationField[];
  }> {
    return this.request(`/templates/${templateId}`);
  }

  async listTemplates(): Promise<Array<{ id: string; name: string; video_id: string }>> {
    return this.request('/templates');
  }

  // ========== Render Personalized Video ==========

  async renderVideo(
    templateId: string,
    fieldValues: Record<string, string>
  ): Promise<PersonalizationJob> {
    const response = await this.request<{ job_id: string; status: string; progress: number }>('/render', {
      method: 'POST',
      body: JSON.stringify({
        template_id: templateId,
        field_values: fieldValues,
      }),
    });

    return {
      id: response.job_id,
      status: response.status as PersonalizationJob['status'],
      progress: response.progress,
    };
  }

  async getJobStatus(jobId: string): Promise<PersonalizationJob> {
    const response = await this.request<{
      job_id: string;
      status: string;
      progress: number;
      output_url?: string;
      error?: string;
    }>(`/jobs/${jobId}`);

    return {
      id: response.job_id,
      status: response.status as PersonalizationJob['status'],
      progress: response.progress,
      outputUrl: response.output_url ? `${API_BASE.replace('/api', '')}${response.output_url}` : undefined,
      error: response.error,
    };
  }

  async pollJobUntilComplete(
    jobId: string,
    onProgress?: (progress: number) => void,
    intervalMs = 2000
  ): Promise<PersonalizationJob> {
    return new Promise((resolve, reject) => {
      const checkStatus = async () => {
        try {
          const job = await this.getJobStatus(jobId);

          if (onProgress) {
            onProgress(job.progress);
          }

          if (job.status === 'completed') {
            resolve(job);
          } else if (job.status === 'failed') {
            reject(new Error(job.error || 'Job failed'));
          } else {
            setTimeout(checkStatus, intervalMs);
          }
        } catch (error) {
          reject(error);
        }
      };

      checkStatus();
    });
  }

  // Legacy endpoint for compatibility
  async createPersonalizationJob(
    request: PersonalizationRequest
  ): Promise<PersonalizationJob> {
    // For now, just return a mock response
    // Full implementation would create template + render
    console.warn('createPersonalizationJob is deprecated, use createTemplate + renderVideo');
    return {
      id: `job-${Date.now()}`,
      status: 'pending',
      progress: 0,
    };
  }

  // ========== Visual Render (Text/Logo Replacement) ==========

  async renderVideoWithReplacements(
    videoId: string,
    textReplacements: Array<{
      original_text: string;
      new_text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      start_time: number;
      end_time: number;
    }>,
    voiceEdits: Array<{
      text: string;
      start_time: number;
      end_time: number;
    }> = []
  ): Promise<{ job_id: string; status: string; progress: number }> {
    return this.request('/videos/' + videoId + '/render', {
      method: 'POST',
      body: JSON.stringify({
        video_id: videoId,
        text_replacements: textReplacements,
        voice_edits: voiceEdits,
      }),
    });
  }

  async getRenderStatus(jobId: string): Promise<{
    job_id: string;
    status: string;
    progress: number;
    output_url?: string;
    error?: string;
  }> {
    return this.request(`/jobs/${jobId}`);
  }

  getRenderDownloadUrl(jobId: string): string {
    return `${API_BASE}/jobs/${jobId}/download`;
  }

  // Get URL for preview playback (doesn't save)
  getPreviewUrl(jobId: string): string {
    return `${API_BASE}/jobs/${jobId}/preview`;
  }

  // Save preview to permanent storage
  async savePreview(jobId: string): Promise<{
    status: string;
    saved_path: string;
    filename: string;
    download_url: string;
  }> {
    return this.request(`/jobs/${jobId}/save`, { method: 'POST' });
  }

  // ========== Lip-Sync (Wav2Lip) ==========

  async applyLipSync(
    videoId: string,
    options: {
      text?: string;
      voiceId?: string;
      audioUrl?: string;
      startTime?: number;
      endTime?: number;
    }
  ): Promise<{ job_id: string; status: string; progress: number }> {
    return this.request(`/videos/${videoId}/lipsync`, {
      method: 'POST',
      body: JSON.stringify({
        text: options.text,
        voice_id: options.voiceId,
        audio_url: options.audioUrl,
        start_time: options.startTime || 0,
        end_time: options.endTime,
      }),
    });
  }

  // ========== Full Personalization Pipeline ==========

  async personalize(
    videoId: string,
    voiceEdits: Array<{
      original_text: string;
      new_text: string;
      start_time: number;
      end_time: number;
      voice_id?: string;
    }>,
    visualReplacements: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      start_time: number;
      end_time: number;
      replacement_type: 'text' | 'blur' | 'remove' | 'image';
      replacement_value: string;
      enable_tracking?: boolean;
      original_text?: string;
    }>,
    defaultVoiceId?: string,
    bubbleSettings?: BubbleSettings,
    deletions?: Array<{
      start_time: number;
      end_time: number;
    }>,
    segments?: Array<{
      id: string;
      original_start: number;
      original_end: number;
      trim_start: number;
      trim_end: number;
      output_start: number;
      order: number;
    }>
  ): Promise<{ job_id: string; status: string; progress: number }> {
    return this.request('/personalize', {
      method: 'POST',
      body: JSON.stringify({
        video_id: videoId,
        voice_edits: voiceEdits,
        visual_replacements: visualReplacements,
        voice_id: defaultVoiceId,
        bubble_settings: bubbleSettings,
        deletions: deletions,
        segments: segments,
      }),
    });
  }

  // ========== Camera Bubble Compositing ==========

  async getVideoInfo(videoId: string): Promise<{
    id: string;
    has_camera: boolean;
    camera_path?: string;
    bubble_settings?: BubbleSettings;
    duration: number;
    width: number;
    height: number;
    preview_path?: string;
    preview_generating?: boolean;
  }> {
    return this.request(`/videos/${videoId}`);
  }

  async compositeBubble(
    videoId: string,
    settings: BubbleSettings,
    preview: boolean = false
  ): Promise<{ job_id: string; status: string; progress: number }> {
    return this.request(`/videos/${videoId}/composite-bubble`, {
      method: 'POST',
      body: JSON.stringify({
        bubble_settings: settings,
        preview,
      }),
    });
  }

  /**
   * Fast bubble-only update using cached processed tracks.
   * Skips TTS + lip-sync, only re-composites the bubble overlay.
   * Use this when adjusting bubble after initial personalization preview.
   */
  async updateBubbleFast(
    jobId: string,
    settings: BubbleSettings
  ): Promise<{ job_id: string; status: string; message: string }> {
    return this.request(`/render/${jobId}/update-bubble`, {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }
}

// Bubble settings for camera overlay
export interface BubbleVisibility {
  start: number;
  end: number;
  visible: boolean;
}

export interface BubbleSettings {
  position: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'custom';
  custom_x?: number;  // 0-1 normalized
  custom_y?: number;  // 0-1 normalized
  size: number;       // 0-1 as fraction of screen width
  shape: 'circle' | 'square' | 'rounded';
  visibility: BubbleVisibility[];  // Time-based visibility
}

// Personalization field for templates
export interface PersonalizationField {
  id: string;
  name: string;
  field_type: 'text' | 'image' | 'voice';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  start_time?: number;
  end_time?: number;
  font_size?: number;
  font_color?: string;
  background_color?: string;
  original_text?: string;
  template_text?: string;
}

export const api = new ApiService();

// Hook for managing async state
export function useApiState<T>() {
  return {
    data: null as T | null,
    loading: false,
    error: null as string | null,
  };
}
