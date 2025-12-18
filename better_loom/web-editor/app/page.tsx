'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { VideoEditor } from '@/components/editor/VideoEditor';
import { Sidebar } from '@/components/editor/Sidebar';
import { Header } from '@/components/editor/Header';
import { RecordingModal } from '@/components/editor/RecordingModal';
import { PersonalizationModal } from '@/components/editor/PersonalizationModal';
import { useEditorStore } from '@/lib/store';
import { api } from '@/lib/api';

export default function Home() {
  const searchParams = useSearchParams();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('Untitled Project');
  const [isRecordingModalOpen, setIsRecordingModalOpen] = useState(false);
  const [isPersonalizeModalOpen, setIsPersonalizeModalOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isLoadingFromDesktop, setIsLoadingFromDesktop] = useState(false);

  const { setVideo, setDuration, transcribeVideo } = useEditorStore();

  // Load video from URL parameter (when opened from desktop app)
  useEffect(() => {
    const videoId = searchParams.get('video');
    if (videoId && !videoUrl) {
      setIsLoadingFromDesktop(true);
      loadVideoFromId(videoId);
    }
  }, [searchParams, videoUrl]);

  const loadVideoFromId = async (videoId: string) => {
    try {
      const videoInfo = await api.getVideoInfo(videoId);
      const streamUrl = api.getVideoStreamUrl(videoId);

      setVideoUrl(streamUrl);
      setVideo(streamUrl, videoId, `Recording ${videoId}`);
      setDuration(videoInfo.duration);
      setProjectName(`Recording ${videoId}`);

      console.log('Loaded video from desktop app:', videoId);
    } catch (error) {
      console.error('Failed to load video:', error);
      setUploadError('Failed to load video from desktop app');
    } finally {
      setIsLoadingFromDesktop(false);
    }
  };

  // Upload video to server for real API processing
  const handleFileUpload = useCallback(async (file: File) => {
    const name = file.name.replace(/\.[^/.]+$/, '');
    setProjectName(name);
    setIsUploading(true);
    setUploadError(null);

    try {
      // Upload to server
      const response = await api.uploadVideo(file);
      const streamUrl = api.getVideoStreamUrl(response.video_id);

      setVideoUrl(streamUrl);
      setVideo(streamUrl, response.video_id, name);
      setDuration(response.duration);

      console.log('Video uploaded:', response.video_id);
    } catch (error) {
      console.error('Upload failed:', error);
      setUploadError(error instanceof Error ? error.message : 'Upload failed');

      // Fallback to local URL for preview (but real API won't work)
      const localUrl = URL.createObjectURL(file);
      setVideoUrl(localUrl);
      setVideo(localUrl, undefined, name);
    } finally {
      setIsUploading(false);
    }
  }, [setVideo, setDuration]);

  const handleRecordingComplete = useCallback((file: File) => {
    handleFileUpload(file);
    setIsRecordingModalOpen(false);
  }, [handleFileUpload]);

  const handleStartRecording = useCallback((mode: string) => {
    setIsRecordingModalOpen(true);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onPersonalize={() => setIsPersonalizeModalOpen(true)}
      />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          onFileUpload={handleFileUpload}
          onStartRecording={handleStartRecording}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {isLoadingFromDesktop ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
                  <svg className="w-8 h-8 text-primary animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <h2 className="text-lg font-medium mb-2">Loading from Desktop App...</h2>
                <p className="text-muted text-sm">Setting up your video for editing</p>
              </div>
            </div>
          ) : videoUrl ? (
            <VideoEditor videoUrl={videoUrl} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <UploadPrompt
                onUpload={handleFileUpload}
                onRecord={() => setIsRecordingModalOpen(true)}
                isUploading={isUploading}
                uploadError={uploadError}
              />
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      <RecordingModal
        isOpen={isRecordingModalOpen}
        onClose={() => setIsRecordingModalOpen(false)}
        onRecordingComplete={handleRecordingComplete}
      />
      <PersonalizationModal
        isOpen={isPersonalizeModalOpen}
        onClose={() => setIsPersonalizeModalOpen(false)}
      />
    </div>
  );
}

function UploadPrompt({
  onUpload,
  onRecord,
  isUploading,
  uploadError,
}: {
  onUpload: (file: File) => void;
  onRecord: () => void;
  isUploading?: boolean;
  uploadError?: string | null;
}) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (isUploading) return;
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      onUpload(file);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isUploading) return;
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
    }
  };

  return (
    <div className="w-full max-w-3xl p-8">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Create Your Video</h1>
        <p className="text-muted">Record a new video or upload an existing one to get started</p>
        <p className="text-xs text-primary mt-2">Real API: Google Chirp 3 + Vision + ElevenLabs + Sync Labs</p>
      </div>

      {uploadError && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm">
          <strong>Upload Error:</strong> {uploadError}
          <p className="text-xs mt-1 text-muted">Make sure the API server is running on localhost:8000</p>
        </div>
      )}

      {isUploading && (
        <div className="mb-6 p-4 bg-primary/10 border border-primary/20 rounded-lg text-center">
          <div className="flex items-center justify-center gap-3">
            <svg className="w-5 h-5 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-sm font-medium">Uploading video to server...</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        {/* Record option */}
        <button
          onClick={onRecord}
          className="p-8 border-2 border-border rounded-xl text-center hover:border-danger transition-colors group"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-danger/20 flex items-center justify-center group-hover:bg-danger/30 transition-colors">
            <div className="w-6 h-6 rounded-full bg-danger" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Record Video</h3>
          <p className="text-sm text-muted">
            Record your screen and webcam directly in the browser
          </p>
        </button>

        {/* Upload option */}
        <div
          className="p-8 border-2 border-dashed border-border rounded-xl text-center hover:border-primary transition-colors cursor-pointer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <input
            id="file-input"
            type="file"
            accept="video/*"
            className="hidden"
            onChange={handleFileSelect}
          />

          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>

          <h3 className="text-lg font-semibold mb-2">Upload Video</h3>
          <p className="text-sm text-muted mb-4">
            Drag and drop or click to select
          </p>

          <div className="flex items-center justify-center gap-3 text-xs text-muted">
            <span>MP4</span>
            <span className="w-1 h-1 rounded-full bg-muted" />
            <span>MOV</span>
            <span className="w-1 h-1 rounded-full bg-muted" />
            <span>WebM</span>
          </div>
        </div>
      </div>
    </div>
  );
}
