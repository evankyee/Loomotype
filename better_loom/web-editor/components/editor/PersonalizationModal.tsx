'use client';

import { useState, useEffect } from 'react';
import { useEditorStore } from '@/lib/store';

interface PersonalizationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PersonalizationModal({ isOpen, onClose }: PersonalizationModalProps) {
  const {
    transcript,
    transcriptEdits,
    visualSelections,
    voices,
    selectedVoiceId,
    isCloning,
    currentJob,
    jobProgress,
    cloneVoice,
    loadVoices,
    setSelectedVoiceId,
    startPersonalization,
    resetJob,
  } = useEditorStore();

  const [voiceName, setVoiceName] = useState('My Voice');
  const [activeTab, setActiveTab] = useState<'voice' | 'edits' | 'generate'>('voice');

  useEffect(() => {
    if (isOpen) {
      loadVoices();
    }
  }, [isOpen, loadVoices]);

  if (!isOpen) return null;

  const hasEdits = transcriptEdits.length > 0 || visualSelections.some(s => s.replacementType);

  const handleCloneVoice = async () => {
    await cloneVoice(voiceName);
  };

  const handleGenerate = async () => {
    setActiveTab('generate');
    await startPersonalization();
  };

  const handleClose = () => {
    resetJob();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">Personalize Video</h2>
          <button
            onClick={handleClose}
            className="p-2 rounded-lg hover:bg-card-hover transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab('voice')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              activeTab === 'voice'
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted hover:text-foreground'
            }`}
          >
            1. Voice Clone
          </button>
          <button
            onClick={() => setActiveTab('edits')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              activeTab === 'edits'
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted hover:text-foreground'
            }`}
          >
            2. Review Edits
          </button>
          <button
            onClick={() => setActiveTab('generate')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              activeTab === 'generate'
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted hover:text-foreground'
            }`}
          >
            3. Generate
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'voice' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium mb-3">Select or Clone Voice</h3>
                <p className="text-sm text-muted mb-4">
                  Choose an existing voice or clone the voice from your video to generate personalized audio.
                </p>

                {/* Existing voices */}
                {voices.length > 0 && (
                  <div className="space-y-2 mb-4">
                    {voices.map((voice) => (
                      <button
                        key={voice.voiceId || voice.id}
                        onClick={() => setSelectedVoiceId(voice.voiceId || voice.id || null)}
                        className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                          selectedVoiceId === (voice.voiceId || voice.id)
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                          <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                          </svg>
                        </div>
                        <div className="flex-1 text-left">
                          <p className="font-medium">{voice.name}</p>
                          <p className="text-xs text-muted capitalize">{voice.status}</p>
                        </div>
                        {selectedVoiceId === (voice.voiceId || voice.id) && (
                          <svg className="w-5 h-5 text-primary" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {/* Clone new voice */}
                <div className="p-4 rounded-lg bg-secondary">
                  <h4 className="text-sm font-medium mb-3">Clone New Voice</h4>
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={voiceName}
                      onChange={(e) => setVoiceName(e.target.value)}
                      placeholder="Voice name"
                      className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <button
                      onClick={handleCloneVoice}
                      disabled={isCloning || !voiceName.trim()}
                      className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {isCloning ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Cloning...
                        </>
                      ) : (
                        'Clone from Video'
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'edits' && (
            <div className="space-y-6">
              {/* Transcript edits */}
              <div>
                <h3 className="text-sm font-medium mb-3">Transcript Edits</h3>
                {transcriptEdits.length === 0 ? (
                  <p className="text-sm text-muted p-4 rounded-lg bg-secondary">
                    No transcript edits yet. Select and edit words in the transcript panel.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {transcriptEdits.map((edit) => (
                      <div
                        key={edit.id}
                        className="p-3 rounded-lg bg-secondary flex items-start gap-3"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-muted">
                              {formatTime(edit.startTime)} - {formatTime(edit.endTime)}
                            </span>
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              edit.status === 'complete' ? 'bg-accent/20 text-accent' :
                              edit.status === 'generating' ? 'bg-yellow-500/20 text-yellow-500' :
                              edit.status === 'error' ? 'bg-danger/20 text-danger' :
                              'bg-muted/20 text-muted'
                            }`}>
                              {edit.status}
                            </span>
                          </div>
                          <p className="text-sm">
                            <span className="text-muted line-through">{edit.originalText}</span>
                            {' → '}
                            <span className="text-accent">{edit.newText}</span>
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Visual replacements */}
              <div>
                <h3 className="text-sm font-medium mb-3">Visual Replacements</h3>
                {visualSelections.filter(s => s.replacementType).length === 0 ? (
                  <p className="text-sm text-muted p-4 rounded-lg bg-secondary">
                    No visual replacements yet. Select areas in the video to replace.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {visualSelections.filter(s => s.replacementType).map((selection) => (
                      <div
                        key={selection.id}
                        className="p-3 rounded-lg bg-secondary flex items-start gap-3"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-muted">
                              {formatTime(selection.startTime)} - {formatTime(selection.endTime)}
                            </span>
                            <span className="text-xs px-2 py-0.5 rounded bg-primary/20 text-primary">
                              {selection.replacementType}
                            </span>
                          </div>
                          <p className="text-sm">
                            {selection.label || 'Unnamed selection'}
                            {selection.replacementValue && (
                              <span className="text-accent"> → {selection.replacementValue}</span>
                            )}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'generate' && (
            <div className="space-y-6">
              {!currentJob && (
                <div className="text-center py-8">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
                    <svg className="w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium mb-2">Ready to Generate</h3>
                  <p className="text-muted text-sm mb-6">
                    {hasEdits
                      ? 'Your edits are ready. Click generate to create your personalized video.'
                      : 'No edits to apply. Add transcript or visual edits first.'}
                  </p>
                  {!selectedVoiceId && transcriptEdits.length > 0 && (
                    <p className="text-yellow-500 text-sm mb-4">
                      Note: Select a voice to generate audio for transcript edits.
                    </p>
                  )}
                  <button
                    onClick={handleGenerate}
                    disabled={!hasEdits}
                    className="px-6 py-3 bg-gradient-to-r from-primary to-primary-hover text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Generate Personalized Video
                  </button>
                </div>
              )}

              {currentJob && currentJob.status !== 'completed' && currentJob.status !== 'failed' && (
                <div className="text-center py-8">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
                    <svg className="w-8 h-8 text-primary animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium mb-2">Processing...</h3>
                  <p className="text-muted text-sm mb-4">
                    Generating your personalized video. This may take a few minutes.
                  </p>
                  <div className="w-full max-w-xs mx-auto">
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-500"
                        style={{ width: `${jobProgress}%` }}
                      />
                    </div>
                    <p className="text-sm text-muted mt-2">{jobProgress}% complete</p>
                  </div>
                </div>
              )}

              {currentJob?.status === 'completed' && (
                <div className="text-center py-8">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent/20 flex items-center justify-center">
                    <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium mb-2">Video Ready!</h3>
                  <p className="text-muted text-sm mb-6">
                    Your personalized video has been generated successfully.
                  </p>
                  {currentJob.outputUrl && (
                    <a
                      href={currentJob.outputUrl}
                      download
                      className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-white rounded-lg font-medium hover:opacity-90 transition-opacity"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download Video
                    </a>
                  )}
                </div>
              )}

              {currentJob?.status === 'failed' && (
                <div className="text-center py-8">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-danger/20 flex items-center justify-center">
                    <svg className="w-8 h-8 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium mb-2">Generation Failed</h3>
                  <p className="text-danger text-sm mb-6">
                    {currentJob.error || 'An error occurred during video generation.'}
                  </p>
                  <button
                    onClick={() => resetJob()}
                    className="px-6 py-3 bg-secondary text-foreground rounded-lg font-medium hover:bg-card-hover transition-colors"
                  >
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <div className="flex items-center gap-3">
            {activeTab === 'voice' && (
              <button
                onClick={() => setActiveTab('edits')}
                className="px-4 py-2 bg-primary text-white rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                Next: Review Edits
              </button>
            )}
            {activeTab === 'edits' && (
              <button
                onClick={() => setActiveTab('generate')}
                className="px-4 py-2 bg-primary text-white rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                Next: Generate
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
