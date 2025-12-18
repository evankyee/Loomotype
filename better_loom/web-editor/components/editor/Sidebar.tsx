'use client';

import { useState } from 'react';

interface SidebarProps {
  onFileUpload: (file: File) => void;
  onStartRecording?: (mode: string) => void;
}

export function Sidebar({ onFileUpload, onStartRecording }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'media' | 'transcript' | 'personalize'>('media');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileUpload(file);
    }
  };

  return (
    <aside className="w-64 border-r border-border bg-card flex flex-col">
      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('media')}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'media'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted hover:text-foreground'
          }`}
        >
          Media
        </button>
        <button
          onClick={() => setActiveTab('transcript')}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'transcript'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted hover:text-foreground'
          }`}
        >
          Transcript
        </button>
        <button
          onClick={() => setActiveTab('personalize')}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === 'personalize'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted hover:text-foreground'
          }`}
        >
          AI
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'media' && (
          <MediaPanel onFileSelect={handleFileSelect} onStartRecording={onStartRecording} />
        )}
        {activeTab === 'transcript' && (
          <TranscriptPanel />
        )}
        {activeTab === 'personalize' && (
          <PersonalizePanel />
        )}
      </div>
    </aside>
  );
}

function MediaPanel({
  onFileSelect,
  onStartRecording
}: {
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStartRecording?: (mode: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Upload section */}
      <div>
        <h3 className="text-sm font-medium mb-2">Upload</h3>
        <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-border rounded-lg hover:border-primary transition-colors cursor-pointer">
          <svg className="w-6 h-6 text-muted mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-sm text-muted">Add video</span>
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={onFileSelect}
          />
        </label>
      </div>

      {/* Record section */}
      <div>
        <h3 className="text-sm font-medium mb-2">Record</h3>
        <div className="space-y-2">
          <button
            onClick={() => onStartRecording?.('screen-camera')}
            className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary hover:bg-card-hover transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-danger/20 flex items-center justify-center">
              <div className="w-3 h-3 rounded-full bg-danger" />
            </div>
            <div>
              <p className="text-sm font-medium">Screen + Camera</p>
              <p className="text-xs text-muted">Record your screen with webcam</p>
            </div>
          </button>
          <button
            onClick={() => onStartRecording?.('screen-only')}
            className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary hover:bg-card-hover transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium">Screen Only</p>
              <p className="text-xs text-muted">Record your screen</p>
            </div>
          </button>
          <button
            onClick={() => onStartRecording?.('camera-only')}
            className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary hover:bg-card-hover transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium">Camera Only</p>
              <p className="text-xs text-muted">Record from webcam</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function TranscriptPanel() {
  return (
    <div className="space-y-4">
      <div className="text-center py-8">
        <svg className="w-12 h-12 mx-auto text-muted mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p className="text-muted text-sm">Upload a video to see the transcript</p>
        <p className="text-muted text-xs mt-1">Transcripts are auto-generated with word-level timestamps</p>
      </div>
    </div>
  );
}

function PersonalizePanel() {
  return (
    <div className="space-y-4">
      <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          AI Personalization
        </h4>
        <p className="text-xs text-muted mt-1">
          Select transcript text or visual elements to personalize with AI
        </p>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Quick Actions</h3>
        <div className="space-y-2">
          <button className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary hover:bg-card-hover transition-colors text-left">
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
            <div>
              <p className="text-sm font-medium">Clone Voice</p>
              <p className="text-xs text-muted">Extract voice from video</p>
            </div>
          </button>
          <button className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary hover:bg-card-hover transition-colors text-left">
            <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <div>
              <p className="text-sm font-medium">Edit Transcript</p>
              <p className="text-xs text-muted">Modify speech with voice clone</p>
            </div>
          </button>
          <button className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary hover:bg-card-hover transition-colors text-left">
            <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <div>
              <p className="text-sm font-medium">Replace Visual</p>
              <p className="text-xs text-muted">Swap selected elements</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
